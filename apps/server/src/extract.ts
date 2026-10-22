import { extractImages, extractText, getDocumentProxy } from "unpdf";
import { chunkText, decodeUtf8, joinPages, LIMITS, type ChunkDraft } from "../../../packages/domain/src/index.ts";
import { IngestError } from "./errors.ts";
import { htmlTitle, htmlToText, sanitizeRichHtml } from "./sanitize.ts";

export type Extraction = {
  method: string;
  extractor: string;
  outcome: "extracted" | "ocr_required" | "empty_document" | "password_protected";
  detail: string;
  contentText: string;
  contentHtml: string | null;
  pageCount: number | null;
  pages: { pageNumber: number; charStart: number; charEnd: number; textChars: number }[];
  chunks: ChunkDraft[];
  ocrRequired: boolean;
  passwordProtected: boolean;
  detectedMime: string;
  extractedTitle: string | null;
};

const EXTRACTOR = "unpdf@1.4.0";

export async function extractDocument(bytes: Uint8Array, kind: "pdf" | "text" | "html"): Promise<Extraction> {
  if (kind === "pdf") return extractPdf(bytes);
  if (kind === "html") return extractHtml(bytes);
  return extractPlain(bytes);
}

async function extractPlain(bytes: Uint8Array): Promise<Extraction> {
  let text: string;
  try {
    text = decodeUtf8(bytes).replace(/\r\n/g, "\n");
  } catch {
    throw new IngestError("mime_mismatch", false, "The file is not valid UTF-8 text");
  }
  return finishText("text", "utf8@1", "text/plain", text, null, null);
}

async function extractHtml(bytes: Uint8Array): Promise<Extraction> {
  let raw: string;
  try {
    raw = decodeUtf8(bytes);
  } catch {
    throw new IngestError("unsupported_type", false, "The page was not valid UTF-8 HTML");
  }
  const title = htmlTitle(raw);
  const safe = sanitizeRichHtml(raw);
  const text = htmlToText(safe);
  const result = finishText("html", "sanitize-html@2.18.1", "text/html", text, safe, null);
  result.extractedTitle = title;
  return result;
}

async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (error) {
    if (isPasswordError(error)) {
      return emptyResult({
        method: "pdf",
        extractor: EXTRACTOR,
        outcome: "password_protected",
        detail: "This PDF asks for a password. Passageworks does not collect PDF passwords and does not bypass protection.",
        detectedMime: "application/pdf",
        pageCount: null,
        passwordProtected: true,
        ocrRequired: false,
      });
    }
    throw new IngestError("pdf_unreadable", false, "The PDF could not be opened");
  }
  try {
    if (pdf.numPages > LIMITS.maxPdfPages) {
      throw new IngestError("page_limit", false, `PDFs are limited to ${LIMITS.maxPdfPages} pages`);
    }
    const extracted = await extractText(pdf, { mergePages: false });
    const pageTexts = extracted.text.map((page) => page ?? "");
    const alnum = pageTexts.join(" ").match(/[A-Za-z0-9]/g)?.length ?? 0;
    if (alnum < LIMITS.minPdfAlnum) {
      const hasImage = await documentHasImage(pdf, bytes);
      if (hasImage) {
        return emptyResult({
          method: "pdf",
          extractor: EXTRACTOR,
          outcome: "ocr_required",
          detail: "This PDF has no usable text layer. It looks scanned or image-based. OCR is not implemented, so no text was invented.",
          detectedMime: "application/pdf",
          pageCount: pdf.numPages,
          passwordProtected: false,
          ocrRequired: true,
        });
      }
      return emptyResult({
        method: "pdf",
        extractor: EXTRACTOR,
        outcome: "empty_document",
        detail: "This PDF has no extractable text and no page image. OCR was not run.",
        detectedMime: "application/pdf",
        pageCount: pdf.numPages,
        passwordProtected: false,
        ocrRequired: false,
      });
    }
    const joined = joinPages(pageTexts);
    const result = finishText("pdf", EXTRACTOR, "application/pdf", joined.text, null, joined.pages);
    result.pageCount = pdf.numPages;
    return result;
  } finally {
    await pdf.destroy();
  }
}

async function documentHasImage(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, raw: Uint8Array): Promise<boolean> {
  const pages = Math.min(pdf.numPages, LIMITS.maxPdfPages);
  for (let page = 1; page <= pages; page += 1) {
    try {
      const images = await extractImages(pdf, page);
      if (images.length > 0) return true;
    } catch {
      return /\/Subtype\s*\/Image/.test(Buffer.from(raw).toString("latin1"));
    }
  }
  return false;
}

function finishText(
  method: string,
  extractor: string,
  detectedMime: string,
  text: string,
  contentHtml: string | null,
  pages: { pageNumber: number; charStart: number; charEnd: number }[] | null,
): Extraction {
  if (text.length > LIMITS.maxExtractedChars) {
    throw new IngestError("extract_limit", false, "The extracted text exceeds the size limit");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return emptyResult({
      method,
      extractor,
      outcome: "empty_document",
      detail: "Extraction finished and produced no text.",
      detectedMime,
      pageCount: pages?.length ?? null,
      passwordProtected: false,
      ocrRequired: false,
    });
  }
  const spans = pages ?? [];
  const chunks = chunkText(text, spans);
  if (chunks.length > LIMITS.maxChunks) {
    throw new IngestError("extract_limit", false, "The document produced too many passages");
  }
  return {
    method,
    extractor,
    outcome: "extracted",
    detail: spans.length
      ? "Text was extracted per page. A passage has a page number only when it sits entirely on one extracted page."
      : "This source has no page model. Passage offsets are into the extracted text. Page positions were not invented.",
    contentText: text,
    contentHtml,
    pageCount: spans.length ? spans.length : null,
    pages: spans.map((page) => ({
      ...page,
      textChars: Math.max(0, page.charEnd - page.charStart),
    })),
    chunks,
    ocrRequired: false,
    passwordProtected: false,
    detectedMime,
    extractedTitle: null,
  };
}

function emptyResult(input: {
  method: string;
  extractor: string;
  outcome: Extraction["outcome"];
  detail: string;
  detectedMime: string;
  pageCount: number | null;
  passwordProtected: boolean;
  ocrRequired: boolean;
}): Extraction {
  const pageCount = input.pageCount ?? 0;
  const pages = input.ocrRequired || input.outcome === "empty_document"
    ? Array.from({ length: pageCount }, (_v, index) => ({
        pageNumber: index + 1,
        charStart: 0,
        charEnd: 0,
        textChars: 0,
      }))
    : [];
  return {
    method: input.method,
    extractor: input.extractor,
    outcome: input.outcome,
    detail: input.detail,
    contentText: "",
    contentHtml: null,
    pageCount: input.pageCount,
    pages,
    chunks: [],
    ocrRequired: input.ocrRequired,
    passwordProtected: input.passwordProtected,
    detectedMime: input.detectedMime,
    extractedTitle: null,
  };
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && (error.name === "PasswordException" || error.message === "No password given");
}

export async function extractWithLimit(bytes: Uint8Array, kind: "pdf" | "text" | "html"): Promise<Extraction> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new IngestError("extract_timeout", true, "Extraction exceeded the time limit"));
    }, LIMITS.maxExtractMs);
  });
  try {
    return await Promise.race([extractDocument(bytes, kind), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
