export type CapabilityStatus = "implemented" | "partial" | "unavailable";

export type Capability = {
  id: string;
  area: string;
  label: string;
  status: CapabilityStatus;
  detail: string;
};

export const STATIC_CAPABILITIES: Capability[] = [
  {
    id: "file.txt",
    area: "File formats",
    label: "Plain text UTF-8",
    status: "implemented",
    detail: "Decoded as UTF-8. NUL bytes and invalid UTF-8 are rejected. The extension is not trusted.",
  },
  {
    id: "file.pdf-text",
    area: "File formats",
    label: "Text-based PDF",
    status: "implemented",
    detail: "Text is extracted per page with PDF.js (unpdf). Page numbers are stored only for chunks that stay on one extracted page.",
  },
  {
    id: "file.note",
    area: "File formats",
    label: "User-entered notes",
    status: "implemented",
    detail: "Captured notes enter the same durable job queue as files and become a source version.",
  },
  {
    id: "file.html-upload",
    area: "File formats",
    label: "HTML file upload",
    status: "unavailable",
    detail: "HTML is accepted only through public HTTP or HTTPS ingestion, then sanitized.",
  },
  {
    id: "file.office",
    area: "File formats",
    label: "DOCX, PPTX, spreadsheets, images, email",
    status: "unavailable",
    detail: "These formats are rejected. No converter is installed.",
  },
  {
    id: "extract.versioned",
    area: "Text extraction",
    label: "Versioned extraction",
    status: "implemented",
    detail: "Each successful or classified attempt appends a source version. Later attempts do not overwrite earlier text.",
  },
  {
    id: "extract.password",
    area: "Text extraction",
    label: "Password-protected PDF",
    status: "implemented",
    detail: "The worker records password_protected and stops. Passwords are not collected and protection is not bypassed.",
  },
  {
    id: "web.html",
    area: "Web ingestion",
    label: "Public HTTP and HTTPS HTML",
    status: "implemented",
    detail: "Manual redirects, DNS checks, pinned lookup, size and time caps, and HTML sanitization. Ports other than 80 and 443 are refused.",
  },
  {
    id: "web.js",
    area: "Web ingestion",
    label: "Logged-in or JavaScript-rendered pages",
    status: "unavailable",
    detail: "No browser session and no headless renderer. The first HTML response is what gets stored.",
  },
  {
    id: "ocr",
    area: "OCR",
    label: "Optical character recognition",
    status: "unavailable",
    detail: "Scanned or image-only PDFs finish as ocr_required with empty text. No OCR engine is called.",
  },
  {
    id: "search.lexical",
    area: "Full-text search",
    label: "Permission-aware lexical search",
    status: "implemented",
    detail: "Postgres tsvector over passage text, source titles, notes, and briefs. Ranking and highlights use websearch_to_tsquery and ts_headline. No model is required.",
  },
  {
    id: "search.semantic",
    area: "Semantic retrieval",
    label: "Embedding similarity",
    status: "unavailable",
    detail: "Not installed. Calling the semantic entry point throws. Brief retrieval does not pretend to rank by meaning.",
  },
  {
    id: "ai.manual",
    area: "AI generation",
    label: "Manual brief editing without a provider",
    status: "implemented",
    detail: "The editor, revisions, and citations save through the API with no model configured.",
  },
  {
    id: "ai.generate",
    area: "AI generation",
    label: "Server-side cited generation",
    status: "partial",
    detail: "An OpenAI-compatible adapter runs only when AI_BASE_URL, AI_API_KEY, and AI_MODEL are all set. Otherwise the API returns ai_unavailable and does not write a draft. This build did not call a live provider.",
  },
  {
    id: "collab.optimistic",
    area: "Collaboration",
    label: "Optimistic concurrency and revision history",
    status: "implemented",
    detail: "Documents store a monotonic revision. A stale baseRevision returns 409 and the current body. Autosave uses the same check.",
  },
  {
    id: "collab.realtime",
    area: "Collaboration",
    label: "Simultaneous real-time editing",
    status: "unavailable",
    detail: "No CRDT, operational transform, or presence channel is running.",
  },
  {
    id: "access.roles",
    area: "Collaboration",
    label: "Workspace roles",
    status: "implemented",
    detail: "Owner, editor, commenter, and viewer are enforced on the server for every project route.",
  },
  {
    id: "access.share",
    area: "Collaboration",
    label: "Expiring revocable share links",
    status: "implemented",
    detail: "The raw token is shown once and stored as a SHA-256 hash. Default links do not include cited passage text.",
  },
  {
    id: "storage.local",
    area: "Storage",
    label: "Private object storage",
    status: "implemented",
    detail: "Bytes live under STORAGE_ROOT with UUID keys. Downloads go through an authorized route as attachments.",
  },
  {
    id: "storage.s3",
    area: "Storage",
    label: "S3-compatible buckets",
    status: "unavailable",
    detail: "No S3 client is implemented. Local private storage is the working backend.",
  },
  {
    id: "jobs.queue",
    area: "Jobs",
    label: "Durable queued jobs",
    status: "implemented",
    detail: "Jobs use queued, processing, completed, failed, and cancelled. The worker claims with FOR UPDATE SKIP LOCKED, retries transient failures, and observes cancellation before commit.",
  },
];

export function capabilityById(id: string): Capability | undefined {
  return STATIC_CAPABILITIES.find((item) => item.id === id);
}
