/**
 * Checks a homepage.json the agent wrote: it passes the same validation the
 * extension applies before saving, and its links look like real scraped URLs.
 *
 * Run: pnpm agent:verify [path]   (default: the last pnpm agent:run output)
 */
import { readFileSync } from "node:fs";
import { CHANNELS, validateHomepageData } from "@homepage/agent-core";
import { OUT_PATH } from "./node-bridge";

const path = process.argv[2] ?? OUT_PATH;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

let result: ReturnType<typeof validateHomepageData>;
try {
  result = validateHomepageData(readFileSync(path, "utf-8"));
} catch (err) {
  fail(String(err));
}
const { data, warnings } = result;
console.log(`✅ valid HomepageData: ${data.items.length} items`);
for (const w of warnings) console.log(`   warning: ${w}`);

for (const c of CHANNELS) {
  const n = data.items.filter((i) => i.channel === c.key).length;
  console.log(`${n ? "✅" : "⚠️ "} ${c.label}: ${n}/${c.slots}`);
}

const urls = new Set(data.items.flatMap((i) => [i.url, ...i.chips.map((c) => c.url)]));
const placeholders = [...urls].filter((u) => /example\.com|placeholder/.test(u));
if (placeholders.length) fail(`placeholder links present: ${placeholders.slice(0, 3).join(", ")}`);
if (urls.size < 5) fail(`only ${urls.size} distinct links; expected real scraped URLs`);
console.log(`✅ ${urls.size} distinct links, no placeholders`);

console.log(`\n\x1b[32mVERIFIED\x1b[0m: ${path}`);
