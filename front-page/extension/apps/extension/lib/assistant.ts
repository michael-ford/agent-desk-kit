/**
 * "Comment for your assistant": the reader's prompt about a story goes to the
 * assistant, which turns it into a tracked issue and routes it (an answer, a
 * note, or an agent session) and replies on your chat channel. The extension's
 * only power here is one narrow local endpoint on
 * the Intake Triage server, which queues `assistant-trigger.sh newtab`. That route
 * answers only this extension's origin. No issue-tracker or agent access lives here.
 *
 * If the server isn't running, the comment waits in an outbox and the worker's
 * heartbeat sends it when the server is back, so nothing is lost.
 */

/** The Intake Triage server (also shown in the Triage view). */
export const INTAKE_BASE = "http://127.0.0.1:8766";

const OUTBOX = "commentOutbox";
const SENT = "commentsSent";
const SENT_KEEP = 200;

export interface AssistantComment {
  url: string;
  headline: string;
  prompt: string;
  /** ISO time the reader wrote it. */
  at: string;
}

/** Per story URL: when its latest comment was queued for the assistant, or that it is waiting in the outbox. */
export type CommentState = { status: "queued" | "waiting"; at: string };

export type SendResult = "queued" | "waiting";

/** The server is down or unreachable (as opposed to answering with an error). */
export class Unreachable extends Error {}

/** The server answered with an error status. */
export class Refused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** POST to one of the server's /api/newtab/ routes; resolves to its JSON reply. */
export async function postIntake(path: string, payload: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${INTAKE_BASE}${path}`, {
      method: "POST",
      // The browser adds Origin: chrome-extension://<id>, which the route checks.
      headers: { "Content-Type": "application/json", "X-Intake-Triage": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (err) {
    throw new Unreachable(err instanceof Error ? err.message : String(err));
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Refused(typeof body.error === "string" ? body.error : `HTTP ${res.status}`, res.status);
  return body;
}

async function post(comment: AssistantComment): Promise<void> {
  await postIntake("/api/newtab/comment", { url: comment.url, headline: comment.headline, prompt: comment.prompt });
}

async function setState(url: string, state: CommentState): Promise<void> {
  const sent = ((await browser.storage.local.get(SENT))[SENT] as Record<string, CommentState> | undefined) ?? {};
  sent[url] = state;
  const trimmed = Object.fromEntries(Object.entries(sent).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, SENT_KEEP));
  await browser.storage.local.set({ [SENT]: trimmed });
}

export async function loadCommentStates(): Promise<Record<string, CommentState>> {
  return ((await browser.storage.local.get(SENT))[SENT] as Record<string, CommentState> | undefined) ?? {};
}

/**
 * Send now. "queued" means the assistant's trigger accepted it; "waiting" means the
 * server is down and it is in the outbox. Any other failure (the trigger
 * itself failed, a bad request) throws with the server's message.
 */
export async function sendComment(input: Omit<AssistantComment, "at">): Promise<SendResult> {
  const comment: AssistantComment = { ...input, prompt: input.prompt.trim(), at: new Date().toISOString() };
  try {
    await post(comment);
    await setState(comment.url, { status: "queued", at: comment.at });
    return "queued";
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    const outbox = ((await browser.storage.local.get(OUTBOX))[OUTBOX] as AssistantComment[] | undefined) ?? [];
    await browser.storage.local.set({ [OUTBOX]: [...outbox, comment] });
    await setState(comment.url, { status: "waiting", at: comment.at });
    return "waiting";
  }
}

/**
 * Called by the worker's heartbeat. Sends waiting comments oldest first and
 * stops at the first that can't be delivered, so order is kept. A comment the
 * server rejects outright (bad request) is dropped with a console error rather
 * than retried forever.
 */
export async function flushCommentOutbox(): Promise<void> {
  const outbox = ((await browser.storage.local.get(OUTBOX))[OUTBOX] as AssistantComment[] | undefined) ?? [];
  if (!outbox.length) return;
  let i = 0;
  for (; i < outbox.length; i++) {
    try {
      await post(outbox[i]);
      await setState(outbox[i].url, { status: "queued", at: new Date().toISOString() });
    } catch (err) {
      if (err instanceof Unreachable) break;
      if (err instanceof Refused && err.status >= 400 && err.status < 500) {
        console.error("[assistant] dropping a comment the server refused", err);
        continue;
      }
      break; // the trigger failed; try again next heartbeat
    }
  }
  const rest = outbox.slice(i);
  // Re-read so a comment added while we were sending isn't lost.
  const now = ((await browser.storage.local.get(OUTBOX))[OUTBOX] as AssistantComment[] | undefined) ?? [];
  const added = now.slice(outbox.length);
  await browser.storage.local.set({ [OUTBOX]: [...rest, ...added] });
}

/** Whether the Intake Triage server answers. */
export async function intakeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${INTAKE_BASE}/api/status`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
