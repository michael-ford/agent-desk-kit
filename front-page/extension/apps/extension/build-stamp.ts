/**
 * Build-time inputs, computed once per `wxt build` in Node (imported by
 * wxt.config.ts only, never by extension code):
 *
 * - The build stamp: when the bundle was built, from which commit, and a hash of
 *   any uncommitted changes. It is baked into the bundle and also written to
 *   `build-info.json` in the output directory, so the running worker can tell
 *   when a newer build is sitting on disk (see lib/build-info.ts).
 * - The world list (config/world.md: projects, deployments,
 *   dependencies, clients), bundled so every build ranks against it.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorldList } from "../../packages/agent-core/world";

export interface BuildInfo {
  /** Unique per build; the worker compares this with the copy on disk. */
  id: string;
  /** ISO time the bundle was built. */
  builtAt: string;
  /** Short commit hash, with "+<hash>" when the tree had uncommitted changes. */
  version: string;
  world: { path: string; found: boolean; asOf: string | null; hash: string | null; entries: number };
}

export const WORLD_LIST_PATH =
  process.env.HOMEPAGE_WORLD_LIST ?? join(dirname(fileURLToPath(import.meta.url)), "../../config/world.md");

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function sourceVersion(): string {
  const commit = git("rev-parse --short HEAD").trim() || "nogit";
  // Uncommitted work is the norm in this repo, so hash it: two builds of the
  // same commit with different local edits must not look identical.
  const diff = git("diff HEAD");
  const root = git("rev-parse --show-toplevel").trim();
  const untracked = git("ls-files --others --exclude-standard --full-name :/")
    .split("\n")
    .filter(Boolean)
    .map((f) => {
      try {
        return f + "\0" + readFileSync(join(root, f), "utf-8");
      } catch {
        return f;
      }
    })
    .join("\0");
  if (!diff && !untracked) return commit;
  return `${commit}+${createHash("sha256").update(diff + untracked).digest("hex").slice(0, 6)}`;
}

export function readWorldList(): { text: string; info: BuildInfo["world"] } {
  if (!existsSync(WORLD_LIST_PATH)) {
    console.warn(`[build-stamp] world list not found at ${WORLD_LIST_PATH}; building without it`);
    return { text: "", info: { path: WORLD_LIST_PATH, found: false, asOf: null, hash: null, entries: 0 } };
  }
  const text = readFileSync(WORLD_LIST_PATH, "utf-8");
  // Parse it the way the extension will. A file that's there but parses to
  // nothing is a format slip; ship it and every "touches" chip silently vanishes.
  const entries = parseWorldList(text).length;
  if (entries === 0) {
    throw new Error(
      `[build-stamp] world list at ${WORLD_LIST_PATH} parsed to 0 entries. ` +
        "Expected '## Group' headings with '- Label: term, term' bullets under them. Build stopped.",
    );
  }
  const asOf =
    text.match(/\(as of (\d{4}-\d{2}-\d{2})\)/)?.[1] ??
    statSync(WORLD_LIST_PATH).mtime.toISOString().slice(0, 10);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 6);
  return { text, info: { path: WORLD_LIST_PATH, found: true, asOf, hash, entries } };
}

export function makeBuildInfo(world: BuildInfo["world"]): BuildInfo {
  const builtAt = new Date().toISOString();
  const version = sourceVersion();
  return { id: `${version}@${builtAt}`, builtAt, version, world };
}
