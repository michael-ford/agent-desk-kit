export interface ParsedEpubFilename {
  title: string;
  author: string | null;
}

const ARCHIVE_SOURCES = new Set(["anna's archive", "annas archive", "libgen", "z-library"]);
const HEX_HASH_RE = /^[0-9a-f]{16,}$/i;
export function parseEpubFilename(filename: string): ParsedEpubFilename {
  // Strip .epub extension
  const base = filename.replace(/\.epub$/i, "").trim();

  // Anna's Archive pattern: segments separated by " -- "
  if (base.includes(" -- ")) {
    const segments = base.split(" -- ");
    const title = segments[0].trim();
    let author: string | null = segments.length > 1 ? segments[1].trim() : null;

    // Validate author — reject hex hashes and archive source names
    if (author && (HEX_HASH_RE.test(author) || ARCHIVE_SOURCES.has(author.toLowerCase()))) {
      author = null;
    }

    return { title: title || filename, author };
  }

  // Simple filename — use as title
  let title = base;

  // Replace underscores/hyphens with spaces if no natural spaces
  if (!title.includes(" ")) {
    title = title.replace(/[_-]+/g, " ").trim();
  }

  return { title: title || filename, author: null };
}
