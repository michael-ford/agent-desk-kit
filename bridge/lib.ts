// Shared pieces for bridge.ts (inbound) and outbound-mcp.ts (send-only tools).
//
// State layout per bot (the same as the official telegram channel plugin's):
//   <stateDir>/access.json  allowlist + delivery options (edited by hand)
//   <stateDir>/bot.pid      pid of the ONE process polling getUpdates (bridge.ts)
//   <stateDir>/inbox/       downloaded photos / attachments

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BotConfig = {
  name: string
  // Where the bot token comes from: an environment variable (default
  // TELEGRAM_BOT_TOKEN_<NAME>) or a command that prints it (tokenCommand).
  tokenEnv: string
  tokenCommand?: string[]
  stateDir: string
  agentIdFile: string
  // Group chats are opt-in per bot (bots.json "groups": true). Off => DMs only.
  groupsEnabled: boolean
}

// One entry per allowed group chat, keyed by chat id (negative number as a string).
export type GroupPolicy = {
  // true (default): only messages that @mention the bot or reply to one of its
  // messages are delivered. false: every message from an allowed sender is.
  requireMention: boolean
  // Who may talk to the bot in this group. Empty => the bot's DM allowFrom.
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  groups?: Record<string, GroupPolicy>
}

const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

// BOTS_JSON overrides the location (tests use bots.example.json).
export const botsJsonPath = () => process.env.BOTS_JSON ?? join(import.meta.dir, 'bots.json')

export function loadBotConfig(name: string): BotConfig {
  const all = JSON.parse(readFileSync(botsJsonPath(), 'utf8'))
  const c = all[name]
  if (!c) throw new Error(`unknown bot "${name}" (bots.json has: ${Object.keys(all).join(', ')})`)
  return {
    name,
    tokenEnv: c.tokenEnv ?? `TELEGRAM_BOT_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    tokenCommand: Array.isArray(c.tokenCommand) && c.tokenCommand.length ? c.tokenCommand.map(String) : undefined,
    stateDir: expand(c.stateDir),
    agentIdFile: expand(c.agentIdFile),
    groupsEnabled: c.groups === true,
  }
}

// The token is read at runtime and never written to config, plists or logs.
// tokenCommand wins when set, so it can come from a secret manager
// (e.g. ["op", "read", "op://Private/my-bot/token"] or ["sops", "-d", ...]).
export function loadToken(cfg: BotConfig): string {
  const token = cfg.tokenCommand
    ? execFileSync(cfg.tokenCommand[0]!, cfg.tokenCommand.slice(1), { encoding: 'utf8' }).trim()
    : (process.env[cfg.tokenEnv] ?? '').trim()
  if (!token) {
    throw new Error(`no token for bot "${cfg.name}": set ${cfg.tokenEnv} or "tokenCommand" in bots.json`)
  }
  return token
}

// Re-read on every use so hand edits to access.json apply without a restart.
// Missing/corrupt file => nobody is allowed (fail closed).
export function loadAccess(cfg: BotConfig): Access {
  try {
    const a = JSON.parse(readFileSync(join(cfg.stateDir, 'access.json'), 'utf8'))
    return {
      dmPolicy: a.dmPolicy ?? 'allowlist',
      allowFrom: (a.allowFrom ?? []).map(String),
      ackReaction: a.ackReaction,
      replyToMode: a.replyToMode,
      textChunkLimit: a.textChunkLimit,
      chunkMode: a.chunkMode,
      groups: parseGroups(a.groups),
    }
  } catch {
    return { dmPolicy: 'disabled', allowFrom: [] }
  }
}

function parseGroups(raw: unknown): Record<string, GroupPolicy> {
  const out: Record<string, GroupPolicy> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, g] of Object.entries(raw as Record<string, any>)) {
    if (!g || typeof g !== 'object') continue
    out[String(id)] = {
      requireMention: g.requireMention !== false,
      allowFrom: Array.isArray(g.allowFrom) ? g.allowFrom.map(String) : [],
    }
  }
  return out
}

export function isAllowedSender(access: Access, userId: string): boolean {
  return access.dmPolicy !== 'disabled' && access.allowFrom.includes(userId)
}

// --- group chats (opt-in) ------------------------------------------------------
export type InboundMeta = {
  chatType: string // 'private' | 'group' | 'supergroup' | 'channel'
  chatId: string
  fromId: string
  text: string // message text or caption
  replyToUserId?: string // author of the message this one replies to
  botId?: string
  botUsername?: string
}

// deliver: hand to the agent; `addressed` = a DM, or a group message that
// @mentions / replies to the bot (only those get the ack reaction and typing,
// so an every-message group isn't covered in 👀). drop: ignore; `log` (ids
// only, never content) if set.
export type Gate = { deliver: true; addressed: boolean } | { deliver: false; log?: string }

export function mentionsBot(text: string, botUsername?: string): boolean {
  if (!botUsername) return false
  const u = botUsername.replace(/[^A-Za-z0-9_]/g, '')
  return u.length > 0 && new RegExp(`@${u}(?![A-Za-z0-9_])`, 'i').test(text)
}

export function gateInbound(groupsEnabled: boolean, access: Access, m: InboundMeta): Gate {
  if (m.chatType === 'private') {
    return isAllowedSender(access, m.fromId)
      ? { deliver: true, addressed: true }
      : { deliver: false, log: `dropped message from non-allowlisted user ${m.fromId}` }
  }
  // Bots without group support drop group messages silently.
  if (!groupsEnabled) return { deliver: false }
  if (m.chatType !== 'group' && m.chatType !== 'supergroup') return { deliver: false }
  const g = access.groups?.[m.chatId]
  if (!g) {
    return {
      deliver: false,
      log: `dropped message in unlisted ${m.chatType} ${m.chatId} from user ${m.fromId} (add the chat id to access.json groups to enable)`,
    }
  }
  const senders = g.allowFrom.length ? g.allowFrom : access.allowFrom
  if (access.dmPolicy === 'disabled' || !senders.includes(m.fromId)) {
    return { deliver: false, log: `dropped message in group ${m.chatId} from non-allowlisted user ${m.fromId}` }
  }
  const addressed = (m.botId != null && m.replyToUserId === m.botId) || mentionsBot(m.text, m.botUsername)
  if (g.requireMention && !addressed) {
    return { deliver: false, log: `ignored message in group ${m.chatId} (no @mention or reply to the bot)` }
  }
  return { deliver: true, addressed }
}

// Outbound: DM chat_id == an allowlisted user id; group chats only if the bot
// opted in AND the chat is listed in access.json groups.
export function isAllowedOutboundChat(groupsEnabled: boolean, access: Access, chatId: string): boolean {
  if (access.allowFrom.includes(chatId)) return true
  return groupsEnabled && !!access.groups?.[chatId]
}

// Same splitting rule as the official plugin.
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// Attribute values are sender-controlled (filenames, usernames) and land inside
// the <channel ...> tag — strip anything that could close the tag or forge a
// second attribute.
export function safeAttr(s: string): string {
  return s.replace(/[<>"\[\]\r\n;]/g, '_')
}

// Message text is sender-controlled too: stop it from closing the wrapper tag.
export function safeBody(s: string): string {
  return s.replace(/<\/?channel\b/gi, m => m.replace('<', '‹'))
}
