#!/usr/bin/env bun
// Inbound half of the Telegram <-> Paseo bridge. One process per bot:
//   bun bridge.ts <bot>          (a key in bots.json)
//
// Long-polls getUpdates (the ONLY poller for this token — the agent's
// outbound-mcp.ts never polls), gates senders on access.json, and delivers each
// message to the bot's Paseo agent as a prompt in the same
// <channel source="telegram" ...> shape the official channel plugin uses, so
// instructions and skills written for that plugin work unchanged.
//
// Delivery goes through paseo-agent-send.sh, which waits for the agent to be
// idle (a plain `paseo send` interrupts a running turn). Messages that arrive
// while a delivery is waiting are batched into the next prompt.
//
// Replies are NOT produced here: the agent decides what to say and calls the
// reply tool (outbound-mcp.ts). Nothing from the agent's transcript is relayed.

import { Bot, GrammyError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  gateInbound,
  loadAccess,
  loadBotConfig,
  loadToken,
  safeAttr,
  safeBody,
} from './lib'

const botName = process.argv[2]
if (!botName) {
  console.error('usage: bun bridge.ts <bot>')
  process.exit(2)
}
const cfg = loadBotConfig(botName)
const TOKEN = loadToken(cfg)
const INBOX = join(cfg.stateDir, 'inbox')
const PID_FILE = join(cfg.stateDir, 'bot.pid')
const SEND = join(import.meta.dir, 'paseo-agent-send.sh')

const log = (msg: string) => console.error(`[${new Date().toISOString()}] bridge ${botName}: ${msg}`)

// --- single-poller guard ------------------------------------------------------
// Telegram allows one getUpdates consumer per token. If a previous poller is
// still alive (a stale bridge, or the official plugin's server.ts), stop it
// first: the same takeover rule the official plugin uses.
mkdirSync(cfg.stateDir, { recursive: true })
try {
  const old = Number(readFileSync(PID_FILE, 'utf8').trim())
  if (old > 1 && old !== process.pid) {
    // PIDs get recycled (e.g. after a reboot): only stop the holder if it
    // really is a telegram poller — this bridge or the plugin's server.ts.
    const cmd = execFileSync('ps', ['-p', String(old), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (cmd.includes('bridge.ts') || cmd.includes('server.ts')) {
      log(`stopping previous poller pid ${old}`)
      process.kill(old, 'SIGTERM')
    }
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

// --- delivery queue ----------------------------------------------------------
const pending: string[] = []
let delivering = false

async function deliverLoop(): Promise<void> {
  if (delivering) return
  delivering = true
  try {
    while (pending.length) {
      const batch = pending.splice(0, pending.length)
      const prompt = batch.join('\n\n')
      const ok = await new Promise<boolean>(resolve => {
        execFile(SEND, [botName, '--steer', '--prompt-file', writePromptFile(prompt)], { timeout: 45 * 60_000 }, (err, _o, stderr) => {
          if (stderr) process.stderr.write(stderr)
          if (err) log(`delivery failed (${err.message}); requeueing ${batch.length} message(s)`)
          resolve(!err)
        })
      })
      if (!ok) {
        pending.unshift(...batch)
        await new Promise(r => setTimeout(r, 15_000))
      } else {
        log(`delivered ${batch.length} message(s)`)
      }
    }
  } finally {
    delivering = false
  }
}

let promptSeq = 0
function writePromptFile(text: string): string {
  const dir = join(cfg.stateDir, 'outbox-prompts')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${Date.now()}-${++promptSeq}.txt`)
  writeFileSync(p, text)
  // Kept briefly for debugging; clean up after the send helper has read it.
  setTimeout(() => { try { unlinkSync(p) } catch {} }, 60 * 60_000)
  return p
}

// --- inbound -----------------------------------------------------------------
type Attachment = { kind: string; file_id: string; size?: number; mime?: string; name?: string }

async function downloadToInbox(fileId: string, uniqueId: string): Promise<string | undefined> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return undefined
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ext = (file.file_path.split('.').pop() ?? 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg'
    const safeId = uniqueId.replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    const path = join(INBOX, `${Date.now()}-${safeId}.${ext}`)
    mkdirSync(INBOX, { recursive: true })
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
    return path
  } catch (err) {
    log(`download failed: ${err}`)
    return undefined
  }
}

async function handleInbound(
  ctx: Context,
  text: string,
  getImage?: () => Promise<string | undefined>,
  att?: Attachment,
): Promise<void> {
  const from = ctx.from
  const chat = ctx.chat
  if (!from || !chat) return
  // Allowlisted senders only. No pairing flow: access.json is edited by hand.
  // DMs only, unless this bot opted in to groups (bots.json "groups": true);
  // then also the group chats listed in access.json "groups" (see gateInbound).
  if (chat.type !== 'private' && !cfg.groupsEnabled) return
  const access = loadAccess(cfg)
  const gate = gateInbound(cfg.groupsEnabled, access, {
    chatType: chat.type,
    chatId: String(chat.id),
    fromId: String(from.id),
    text,
    replyToUserId: ctx.message?.reply_to_message?.from?.id != null ? String(ctx.message.reply_to_message.from.id) : undefined,
    botId: String(bot.botInfo.id),
    botUsername: bot.botInfo.username,
  })
  if (!gate.deliver) {
    if (gate.log) log(gate.log)
    return
  }
  const isGroup = chat.type !== 'private'

  const chat_id = String(chat.id)
  const msgId = ctx.message?.message_id

  if (gate.addressed) void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  if (gate.addressed && access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }])
      .catch(() => {})
  }

  const imagePath = getImage ? await getImage() : undefined
  const attrs: Record<string, string> = {
    source: 'telegram',
    chat_id,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    user: safeAttr(from.username ?? String(from.id)),
    user_id: String(from.id),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    // Group messages only (DM tags are unchanged): chat_id is the group, not the sender.
    ...(isGroup
      ? {
          chat_type: chat.type,
          ...('title' in chat && chat.title ? { chat_title: safeAttr(chat.title) } : {}),
          ...(ctx.message?.reply_to_message?.message_id != null
            ? { reply_to_message_id: String(ctx.message.reply_to_message.message_id) }
            : {}),
        }
      : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(att
      ? {
          attachment_kind: att.kind,
          attachment_file_id: safeAttr(att.file_id),
          ...(att.size != null ? { attachment_size: String(att.size) } : {}),
          ...(att.mime ? { attachment_mime: safeAttr(att.mime) } : {}),
          ...(att.name ? { attachment_name: safeAttr(att.name) } : {}),
        }
      : {}),
  }
  const tag = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')
  pending.push(`<channel ${tag}>\n${safeBody(text)}\n</channel>`)
  log(`queued message ${msgId ?? '?'}${att ? ` (+${att.kind})` : ''}${imagePath ? ' (+photo)' : ''}`)
  void deliverLoop()
}

const bot = new Bot(TOKEN)

bot.on('message:text', ctx => handleInbound(ctx, ctx.message.text))
bot.on('message:photo', ctx => {
  const best = ctx.message.photo[ctx.message.photo.length - 1]!
  return handleInbound(ctx, ctx.message.caption ?? '(photo)', () => downloadToInbox(best.file_id, best.file_unique_id))
})
bot.on('message:document', ctx => {
  const d = ctx.message.document
  return handleInbound(ctx, ctx.message.caption ?? `(document: ${safeAttr(d.file_name ?? 'file')})`, undefined, {
    kind: 'document', file_id: d.file_id, size: d.file_size, mime: d.mime_type, name: d.file_name,
  })
})
bot.on('message:voice', ctx => {
  const v = ctx.message.voice
  return handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type,
  })
})
bot.on('message:audio', ctx => {
  const a = ctx.message.audio
  return handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeAttr(a.title ?? a.file_name ?? 'audio')})`, undefined, {
    kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name: a.file_name,
  })
})
bot.on('message:video', ctx => {
  const v = ctx.message.video
  return handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: v.file_name,
  })
})
bot.on('message:video_note', ctx => {
  const v = ctx.message.video_note
  return handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: v.file_id, size: v.file_size })
})
bot.on('message:sticker', ctx => {
  const s = ctx.message.sticker
  return handleInbound(ctx, `(sticker${s.emoji ? ` ${s.emoji}` : ''})`, undefined, {
    kind: 'sticker', file_id: s.file_id, size: s.file_size,
  })
})

// A basic group that becomes a supergroup gets a NEW chat id; access.json must
// follow it or the bot goes deaf there. Log it loudly (group-enabled bots only).
bot.on('message:migrate_to_chat_id', ctx => {
  if (!cfg.groupsEnabled) return
  log(`group ${ctx.chat.id} migrated to supergroup ${ctx.message.migrate_to_chat_id}: update access.json groups`)
})

// A throw in a handler must not stop polling (grammy's default stops the bot).
bot.catch(err => log(`handler error (polling continues): ${err.error}`))

// --- lifecycle ----------------------------------------------------------------
let stopping = false
function shutdown(sig: string) {
  if (stopping) return
  stopping = true
  log(`${sig}: stopping`)
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE)
  } catch {}
  void bot.stop().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Retry forever with backoff; a 409 means another poller holds the token.
for (let attempt = 1; !stopping; attempt++) {
  try {
    await bot.start({
      drop_pending_updates: false,
      onStart: info => {
        attempt = 0
        log(`polling as @${info.username}`)
      },
    })
    break
  } catch (err) {
    if (stopping) break
    const is409 = err instanceof GrammyError && err.error_code === 409
    const delay = Math.min(1000 * attempt, 15_000)
    log(`${is409 ? '409 Conflict — another poller holds this token' : `polling error: ${err}`}; retry in ${delay / 1000}s`)
    await new Promise(r => setTimeout(r, delay))
  }
}
