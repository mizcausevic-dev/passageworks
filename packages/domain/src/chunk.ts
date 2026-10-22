import { LIMITS } from "./limits.ts";

export type PageSpan = {
  pageNumber: number;
  charStart: number;
  charEnd: number;
};

export type ChunkDraft = {
  ordinal: number;
  text: string;
  charStart: number;
  charEnd: number;
  pageNumber: number | null;
};

export function joinPages(pageTexts: string[]): { text: string; pages: PageSpan[] } {
  const pages: PageSpan[] = [];
  let text = "";
  pageTexts.forEach((raw, index) => {
    const piece = raw.replace(/\r\n/g, "\n").trim();
    const start = text.length;
    if (index > 0 && text.length > 0) text += "\n\n";
    const contentStart = text.length;
    text += piece;
    pages.push({
      pageNumber: index + 1,
      charStart: contentStart,
      charEnd: text.length,
    });
    if (piece.length === 0) {
      pages[pages.length - 1] = { pageNumber: index + 1, charStart: start, charEnd: start };
    }
  });
  return { text, pages };
}

export function chunkText(text: string, pages: PageSpan[]): ChunkDraft[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (pages.length > 0) {
    const out: ChunkDraft[] = [];
    for (const page of pages) {
      const local = pack(normalized, page.charStart, page.charEnd);
      for (const piece of local) {
        out.push({ ...piece, ordinal: out.length + 1, pageNumber: page.pageNumber });
      }
    }
    return out;
  }
  return pack(normalized, 0, normalized.length).map((piece, index) => ({
    ...piece,
    ordinal: index + 1,
    pageNumber: null,
  }));
}

function pack(text: string, from: number, to: number): Omit<ChunkDraft, "ordinal" | "pageNumber">[] {
  const region = text.slice(from, to);
  if (!region.trim()) return [];
  const breaks = splitParagraphs(region, from);
  const groups: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const trimmed = trimRange(text, cur.start, cur.end);
    if (trimmed) groups.push(trimmed);
    cur = null;
  };
  for (const part of breaks) {
    if (!cur) {
      cur = { ...part };
    } else if (part.end - cur.start <= LIMITS.chunkTarget) {
      cur.end = part.end;
    } else {
      flush();
      cur = { ...part };
    }
    if (cur && cur.end - cur.start >= LIMITS.chunkMax) flush();
  }
  flush();
  return groups.map((g) => ({
    text: text.slice(g.start, g.end),
    charStart: g.start,
    charEnd: g.end,
  }));
}

function splitParagraphs(region: string, base: number): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(region))) {
    parts.push({ start: base + last, end: base + match.index });
    last = match.index + match[0].length;
  }
  parts.push({ start: base + last, end: base + region.length });
  return parts.filter((p) => region.slice(p.start - base, p.end - base).trim().length > 0);
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] ?? "")) s += 1;
  while (e > s && /\s/.test(text[e - 1] ?? "")) e -= 1;
  if (s >= e) return null;
  return { start: s, end: e };
}
