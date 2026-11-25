import type { MessageEntity } from "grammy/types";

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/127\./,
  /^https?:\/\/localhost/,
  /^https?:\/\/\[::1\]/,
];

function isPrivateUrl(url: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(url));
}

function isValidUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isPrivateUrl(raw)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function extractUrls(
  text: string | undefined,
  entities: MessageEntity[] | undefined
): string[] {
  if (!text || !entities) return [];

  const urls: string[] = [];

  for (const entity of entities) {
    let raw: string | undefined;

    if (entity.type === "url") {
      raw = text.substring(entity.offset, entity.offset + entity.length);
    } else if (entity.type === "text_link") {
      raw = entity.url;
    }

    if (!raw) continue;

    // Add protocol if missing
    if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
      raw = "https://" + raw;
    }

    const valid = isValidUrl(raw);
    if (valid && !urls.includes(valid)) {
      urls.push(valid);
    }
  }

  return urls;
}
