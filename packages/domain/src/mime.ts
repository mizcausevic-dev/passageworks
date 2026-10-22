export type DetectedKind = "pdf" | "text" | "html" | "unsupported";

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

export function detectKind(bytes: Uint8Array, contentTypeHeader?: string | null): DetectedKind {
  if (bytes.length >= PDF.length && PDF.every((b, i) => bytes[i] === b)) return "pdf";
  const header = (contentTypeHeader ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const sample = decodeSample(bytes);
  if (sample == null) {
    if (header === "application/pdf") return "unsupported";
    return "unsupported";
  }
  if (header === "text/html" || header === "application/xhtml+xml") return "html";
  if (looksLikeHtml(sample) && header !== "text/plain") return "html";
  if (header === "text/plain" || header === "" || header === "application/octet-stream" || header.startsWith("text/")) {
    return "text";
  }
  if (header === "application/pdf") return "unsupported";
  return "unsupported";
}

function decodeSample(bytes: Uint8Array): string | null {
  const slice = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (slice.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return null;
  }
}

function looksLikeHtml(sample: string): boolean {
  const head = sample.trimStart().slice(0, 400).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || /<body[\s>]/.test(head) || /<p[\s>]/.test(head);
}

export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("nul_byte");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
