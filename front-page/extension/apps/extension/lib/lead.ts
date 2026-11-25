import type { Homepage } from "./storage";

/** The lead headline of a stored homepage, so the next build can be told not to lead with it again. */
export function leadOf(homepage: Homepage | undefined): string | null {
  if (homepage?.data) return homepage.data.items.find((i) => i.id === homepage.data!.lead)?.headline ?? null;
  return homepage?.code ? extractLead(homepage.code) : null;
}

/**
 * Legacy pages (agent-written TSX): best-effort recovery of the lead from the
 * item object literals, taking the highest `score`.
 */

const ITEM = /title:\s*(['"`])((?:\\.|(?!\1).)+)\1[\s\S]{0,600}?score:\s*(\d+)/g;

export function extractLead(code: string): string | null {
  let best: { title: string; score: number } | null = null;
  for (const m of code.matchAll(ITEM)) {
    const score = Number(m[3]);
    if (!best || score > best.score) best = { title: m[2].replace(/\\(.)/g, "$1"), score };
  }
  return best?.title ?? null;
}

/** Keep the last few leads, newest first, without duplicates. */
export function rememberLead(recent: string[], lead: string, keep = 5): string[] {
  return [lead, ...recent.filter((t) => t !== lead)].slice(0, keep);
}
