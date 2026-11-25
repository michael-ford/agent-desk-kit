import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "wxt";
import { makeBuildInfo, readWorldList } from "./build-stamp";

const world = readWorldList();
const buildInfo = makeBuildInfo(world.info);

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Chrome loads the unpacked extension from .output/chrome-mv3. Point test
  // builds elsewhere (HOMEPAGE_OUT_DIR) so they never replace the live one.
  outDir: process.env.HOMEPAGE_OUT_DIR ?? ".output",
  vite: () => ({
    define: {
      __BUILD_INFO__: JSON.stringify(buildInfo),
      __WORLD_LIST__: JSON.stringify(world.text),
    },
  }),
  hooks: {
    // Written last, so its presence means the whole build is on disk. The
    // running worker compares it with its own baked-in stamp.
    "build:done": (wxt) => {
      writeFileSync(join(wxt.config.outDir, "build-info.json"), JSON.stringify(buildInfo, null, 2));
      console.log(`[build-stamp] ${buildInfo.version} built ${buildInfo.builtAt}; world list ${world.info.found ? `as of ${world.info.asOf}, ${world.info.entries} entries` : "MISSING"}`);
    },
  },
  manifest: {
    name: "AI Homepage",
    description: "A new-tab page an agent rebuilds daily from what you've actually been browsing.",
    permissions: [
      "history", //       getHistory tool
      "tabs", //          getPageHtml: open pages and watch them load
      "scripting", //     getPageHtml: inject the scraper into loaded pages
      "storage", //       API key, settings, the built homepage
      "alarms", //        heartbeat: scheduled rebuilds + reattach after a worker kill
      "notifications", // surface a failed headless rebuild when no tab is open
    ],
    // Needed to scrape arbitrary pages; also exempts api.anthropic.com from CORS.
    host_permissions: ["<all_urls>"],
  },
});
