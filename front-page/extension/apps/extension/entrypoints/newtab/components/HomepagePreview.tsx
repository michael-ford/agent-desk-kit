import { useEffect } from "react";
import { SandpackLayout, SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import { sendToKobo } from "@/lib/kobo";

const INDEX_JS = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

// Tabs opened from inside the preview inherit its sandbox, which breaks sites
// like YouTube and Google. Hand every link click to the extension instead.
document.addEventListener("click", (e) => {
  const kobo = e.target instanceof Element ? e.target.closest("[data-kobo-url]") : null;
  if (kobo) {
    e.preventDefault();
    e.stopPropagation();
    kobo.setAttribute("data-kobo-state", "sending");
    kobo.style.opacity = "0.5";
    window.parent.postMessage({ type: "homepage:send-kobo", url: kobo.getAttribute("data-kobo-url") }, "*");
    return;
  }
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  window.parent.postMessage({ type: "homepage:open-url", url: a.href, newTab: a.target === "_blank" || e.metaKey || e.ctrlKey }, "*");
}, true);

// Result of a "send to Kobo" click, posted back by the extension page.
window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "homepage:kobo-result") return;
  document.querySelectorAll("[data-kobo-url]").forEach((el) => {
    if (el.getAttribute("data-kobo-url") !== msg.url) return;
    el.style.opacity = "1";
    el.setAttribute("data-kobo-state", msg.ok ? "sent" : "error");
    el.textContent = msg.ok ? "\u2713" : "!";
    el.title = msg.message;
  });
});`;

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>My Personalized Homepage</title></head>
<body><div id="root"></div></body></html>`;

/**
 * Renders the agent's component in a Sandpack iframe. The code is
 * model-generated, so it runs sandboxed rather than in the extension's own page.
 */
export function HomepagePreview({ code }: { code: string }) {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; url?: unknown; newTab?: boolean } | null;
      if (msg?.type === "homepage:send-kobo" && typeof msg.url === "string") {
        const url = msg.url;
        const reply = (ok: boolean, message: string) =>
          (e.source as Window | null)?.postMessage({ type: "homepage:kobo-result", url, ok, message }, "*");
        sendToKobo(url).then(
          (r) => reply(true, r === "queued" ? "Sent to Kobo: it syncs once the EPUB is built" : "Already in your Kobo library"),
          (err) => reply(false, `Kobo send failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      if (msg?.type !== "homepage:open-url" || typeof msg.url !== "string") return;
      let url: URL;
      try {
        url = new URL(msg.url);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (msg.newTab) void browser.tabs.create({ url: url.href });
      else void browser.tabs.update({ url: url.href });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const files = {
    "/App.js": { code },
    "/index.js": { code: INDEX_JS },
    "/index.html": { code: INDEX_HTML },
  };

  return (
    <SandpackProvider files={files} template="react" options={{ autorun: true }}>
      <SandpackLayout style={{ height: "100vh", width: "100vw" }}>
        <SandpackPreview style={{ height: "100%" }} />
      </SandpackLayout>
    </SandpackProvider>
  );
}
