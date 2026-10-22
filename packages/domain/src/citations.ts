const PASSAGE_RE = /psg_[a-f0-9]{16}/;
const MARKER_RE = /\[\[(psg_[a-f0-9]{16})\]\]/g;

export type DraftFlag = {
  type: "unsupported_claim" | "unknown_citation";
  text: string;
  citationId?: string;
};

export function isPassageId(value: string): boolean {
  return PASSAGE_RE.test(value) && value.length === 20;
}

export function reviewDraft(draft: string, allowed: ReadonlySet<string>): {
  flags: DraftFlag[];
  unknownIds: string[];
  usedIds: string[];
} {
  const used = new Set<string>();
  const unknown = new Set<string>();
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(draft))) {
    const id = match[1] ?? "";
    used.add(id);
    if (!allowed.has(id)) unknown.add(id);
  }
  const flags: DraftFlag[] = [];
  for (const id of unknown) flags.push({ type: "unknown_citation", text: id, citationId: id });
  for (const sentence of draft.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 8) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.includes("[[psg_")) continue;
    flags.push({ type: "unsupported_claim", text: trimmed });
  }
  return { flags, unknownIds: [...unknown], usedIds: [...used] };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Model output is escaped as text. Only known passage markers become cite elements. */
export function draftToSafeHtml(draft: string, allowed: ReadonlySet<string>): string {
  const escaped = escapeHtml(draft).replace(/\[\[(psg_[a-f0-9]{16})\]\]/g, (_full, id: string) => {
    if (!allowed.has(id)) return "";
    return `<cite data-passage-id="${id}">${id}</cite>`;
  });
  const paragraphs = escaped.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return "";
  return paragraphs.map((p) => `<p>${p.replaceAll("\n", "<br>")}</p>`).join("");
}

export function passageIdsInHtml(html: string): string[] {
  const ids: string[] = [];
  const re = /data-passage-id="(psg_[a-f0-9]{16})"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (match[1]) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export const AI_DISCLOSURE =
  "Selected source passages and your instruction are sent to the configured external model provider. Generation can be incomplete or wrong. Checking citation identifiers confirms that a marker points at a passage that was supplied from a source you can access. It does not prove the sentence is semantically supported, and it does not mean the brief is free of invented claims.";

export const SEMANTIC_RETRIEVAL = {
  status: "unavailable",
  reason:
    "No embedding model, vector column, or similarity query is installed. Brief retrieval uses permission-scoped lexical search. An interface that is not backed by an index is not listed as supported.",
} as const;

export function semanticSearch(): never {
  throw new Error("SEMANTIC_UNAVAILABLE");
}
