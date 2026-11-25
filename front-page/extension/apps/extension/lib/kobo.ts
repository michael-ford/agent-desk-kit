/**
 * "Send to reader": where the 📖 button and the morning edition deliver.
 *
 * - service "wallabag": your koreader-sync (or any Wallabag-compatible) server,
 *   through its API (OAuth password grant, then POST /api/entries). KOReader's
 *   Wallabag client then syncs the EPUB to a Kobo or other e-reader.
 * - service "readwise": Readwise Reader (https://readwise.io/reader_api), for an
 *   iPad or phone. Articles are saved by URL and Reader cleans them itself; the
 *   front page is saved as an HTML document under a made-up unique URL.
 *
 * The function names still say Kobo; they deliver to whichever service is set.
 */
export type DeliveryService = "wallabag" | "readwise";

/** A Wallabag entry id is a number; a Readwise Reader document id is a string. */
export type EntryId = number | string;

export interface KoboConfig {
  service: DeliveryService;
  /** Readwise access token (readwise.io/access_token); used when service is "readwise". */
  readwiseToken: string;
  baseUrl: string;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
}

const KEY = "koboConfig";

export const DEFAULT_KOBO_CONFIG: KoboConfig = {
  service: "wallabag",
  readwiseToken: "",
  baseUrl: "",
  username: "",
  password: "",
  clientId: "",
  clientSecret: "",
};

export async function loadKoboConfig(): Promise<KoboConfig> {
  const s = await browser.storage.local.get(KEY);
  return { ...DEFAULT_KOBO_CONFIG, ...(s[KEY] as Partial<KoboConfig> | undefined) };
}

export async function saveKoboConfig(config: KoboConfig): Promise<void> {
  await browser.storage.local.set({ [KEY]: config });
  token = null;
}

let token: { value: string; expires: number } | null = null;

async function getToken(cfg: KoboConfig): Promise<string> {
  if (token && token.expires > Date.now()) return token.value;
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      username: cfg.username,
      password: cfg.password,
    }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  token = { value: body.access_token, expires: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  return token.value;
}

/** A request to the koreader-sync API with a bearer token, logging in again once on a 401. */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = await loadKoboConfig();
  if (!cfg.baseUrl || !cfg.password) throw new Error("set the server URL and password in Settings → Send to reader");
  const send = async (t: string) =>
    fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(60_000),
    });
  let res = await send(await getToken(cfg));
  if (res.status === 401) {
    token = null;
    res = await send(await getToken(cfg));
  }
  return res;
}

// ---- Readwise Reader ---------------------------------------------------------

const READWISE_API = "https://readwise.io/api/v3";
/** Tag on everything this extension saves to Reader, so it can be filtered. */
const READWISE_TAG = "front-page-kit";

async function readwiseFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = await loadKoboConfig();
  if (!cfg.readwiseToken) throw new Error("set the Readwise access token in Settings → Send to reader");
  return fetch(`${READWISE_API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Token ${cfg.readwiseToken}` },
    signal: AbortSignal.timeout(60_000),
  });
}

/** POST /save/: 201 created, 200 already saved. Returns Reader's document id. */
async function readwiseSave(body: Record<string, unknown>): Promise<{ result: "queued" | "duplicate"; id?: string }> {
  const res = await readwiseFetch("/save/", { method: "POST", body: JSON.stringify({ saved_using: "front-page-kit", ...body }) });
  if (res.status !== 201 && res.status !== 200) throw new Error(`Readwise save failed (${res.status})`);
  const out = (await res.json().catch(() => ({}))) as { id?: unknown };
  return { result: res.status === 201 ? "queued" : "duplicate", id: typeof out.id === "string" ? out.id : undefined };
}

async function readwiseArchive(id: string): Promise<void> {
  const res = await readwiseFetch(`/update/${encodeURIComponent(id)}/`, { method: "PATCH", body: JSON.stringify({ location: "archive" }) });
  if (!res.ok && res.status !== 404) throw new Error(`Readwise archive failed (${res.status})`);
}

// ---- delivery -----------------------------------------------------------------

/** Save a URL. "queued": a new entry was created; "duplicate": it was already saved (by anyone). */
export async function saveToKobo(url: string): Promise<{ result: "queued" | "duplicate"; id?: EntryId }> {
  if ((await loadKoboConfig()).service === "readwise") return readwiseSave({ url, tags: [READWISE_TAG] });
  const res = await authedFetch("/api/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`save failed (${res.status})`);
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  return { result: res.status === 201 ? "queued" : "duplicate", id: typeof body.id === "number" ? body.id : undefined };
}

/** Returns "queued" for a new article or "duplicate" if it was already saved. */
export async function sendToKobo(url: string): Promise<"queued" | "duplicate"> {
  return (await saveToKobo(url)).result;
}

/** Upload a ready-made EPUB (POST /api/entries/upload). Returns the new entry's id. */
export async function uploadEpubToKobo(epub: Uint8Array, opts: { filename: string; title: string; tags?: string[] }): Promise<number> {
  const form = new FormData();
  form.append("file", new Blob([epub as BlobPart], { type: "application/epub+zip" }), opts.filename);
  form.append("title", opts.title);
  form.append("author", "AI newtab");
  if (opts.tags?.length) form.append("tags", opts.tags.join(","));
  const res = await authedFetch("/api/entries/upload", { method: "POST", body: form });
  if (res.status !== 201) throw new Error(`upload failed (${res.status})`);
  const body = (await res.json()) as { id?: number };
  if (typeof body.id !== "number") throw new Error("upload returned no entry id");
  return body.id;
}

/**
 * Deliver the morning front page: the EPUB to a Wallabag server, or the HTML to
 * Readwise Reader (`url` is a made-up unique address; Reader requires one).
 */
export async function uploadFrontPage(page: {
  epub: Uint8Array;
  html: string;
  url: string;
  filename: string;
  title: string;
  tags: string[];
}): Promise<EntryId> {
  if ((await loadKoboConfig()).service === "readwise") {
    const saved = await readwiseSave({
      url: page.url,
      html: page.html,
      should_clean_html: false,
      title: page.title,
      author: "Front page",
      category: "article",
      tags: [READWISE_TAG, ...page.tags],
    });
    if (saved.id === undefined) throw new Error("Readwise save returned no document id");
    return saved.id;
  }
  return uploadEpubToKobo(page.epub, { filename: page.filename, title: page.title, tags: page.tags });
}

/** Archive an entry, so the reader stops listing it as unread. A missing entry counts as archived. */
export async function archiveKoboEntry(id: EntryId): Promise<void> {
  if (typeof id === "string") return readwiseArchive(id);
  const res = await authedFetch(`/api/entries/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archive: 1 }),
  });
  if (!res.ok && res.status !== 404) throw new Error(`archive failed (${res.status})`);
}
