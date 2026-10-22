import sanitizeHtml from "sanitize-html";

const PASSAGE = /^psg_[a-f0-9]{16}$/;

export function sanitizeRichHtml(input: string): string {
  const withMarkers = input.replace(/\[\[(psg_[a-f0-9]{16})\]\]/g, (_full, id: string) => {
    return `<cite data-passage-id="${id}">${id}</cite>`;
  });
  return sanitizeHtml(withMarkers, {
    allowedTags: ["p", "br", "strong", "em", "h1", "h2", "h3", "ul", "ol", "li", "a", "blockquote", "code", "pre", "cite"],
    allowedAttributes: {
      a: ["href", "rel"],
      cite: ["data-passage-id"],
    },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tagName, attribs) => {
        const href = attribs.href ?? "";
        if (!/^https?:\/\//i.test(href)) return { tagName: "span", attribs: {} };
        return { tagName: "a", attribs: { href, rel: "nofollow noopener noreferrer" } };
      },
    } as sanitizeHtml.IOptions["transformTags"],
    exclusiveFilter: (frame) => {
      if (frame.tag !== "cite") return false;
      return !PASSAGE.test(frame.attribs["data-passage-id"] ?? "");
    },
  }).trim();
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|li|blockquote|pre|tr)>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlTitle(raw: string): string | null {
  const match = raw.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (!match?.[1]) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title.slice(0, 200) || null;
}

export function stripSharedCitations(html: string): string {
  return html
    .replace(/<cite\b[^>]*>[\s\S]*?<\/cite>/gi, "<sup>citation</sup>")
    .replace(/psg_[a-f0-9]{16}/g, "citation");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCode(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCode(code: number): string {
  if (!Number.isInteger(code) || code < 32 || code === 127 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}
