/**
 * the reader's seen/read memory, in chrome.storage.local (see agent-core seen.ts for
 * the rules). Pages record what they showed and what they clicked; the worker
 * sends the list with each build so the model doesn't re-pick old stories.
 */
import { pruneSeen, recordClicked, recordShown, type NewsItem, type SeenStore } from "@homepage/agent-core";

const KEY = "seenItems";

export async function loadSeen(): Promise<SeenStore> {
  return ((await browser.storage.local.get(KEY))[KEY] as SeenStore | undefined) ?? {};
}

/** Read-modify-write; pages and the worker are the only writers and writes are rare. */
async function update(fn: (s: SeenStore) => SeenStore): Promise<SeenStore> {
  const next = pruneSeen(fn(await loadSeen()), new Date());
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export const markShown = (items: NewsItem[], pageBuilt: string) => update((s) => recordShown(s, items, pageBuilt));

export const markClicked = (item: NewsItem) => update((s) => recordClicked(s, item, new Date().toISOString()));
