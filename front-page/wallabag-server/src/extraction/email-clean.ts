import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";

const TRACKING_DOMAINS = [
  "open.substack.com",
  "list-manage.com/track",
  "links.beehiiv.com",
  "email.mg.",
];

function isTrackingPixel(attribs: Record<string, string>): boolean {
  if (attribs.width === "1" || attribs.height === "1") return true;
  const src = attribs.src ?? "";
  return TRACKING_DOMAINS.some((domain) => src.includes(domain));
}

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "a", "img",
  "strong", "b", "em", "i",
  "blockquote", "pre", "code",
  "table", "thead", "tbody", "tr", "th", "td",
];

export function emailHtmlToMarkdown(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href"],
      img: ["src", "alt"],
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "img") {
        return isTrackingPixel(frame.attribs);
      }
      return false;
    },
  });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  // Remove empty table cells (email layout artifacts)
  turndown.addRule("emptyTableCell", {
    filter: (node) => {
      if (node.nodeName !== "TD") return false;
      const text = node.textContent?.trim() ?? "";
      const hasImg = node.querySelector("img") !== null;
      return text === "" && !hasImg;
    },
    replacement: () => "",
  });

  return turndown.turndown(clean);
}
