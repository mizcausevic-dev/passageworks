import {
  AI_DISCLOSURE,
  COLLABORATION,
  SEMANTIC_RETRIEVAL,
  STATIC_CAPABILITIES,
  chunkText,
  joinPages,
  reviewDraft,
} from "@passageworks/domain";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type User = { id: string; email: string; name: string };
export type Workspace = { id: string; name: string; role: string };
export type Project = { id: string; workspace_id?: string; workspaceId?: string; name: string; description?: string; role?: string };
export type Source = {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: string;
  title: string;
  outcome: string | null;
  outcomeDetail: string | null;
  originalFilename?: string | null;
  detectedMime?: string | null;
  byteSize?: number | null;
  originUrl?: string | null;
  createdAt?: string | null;
  ingestedAt?: string | null;
  metadata?: Record<string, unknown>;
};
export type Chunk = { passageId: string; ordinal: number; text: string; charStart: number; charEnd: number; pageNumber: number | null };
export type Version = {
  id: string;
  versionNumber: number;
  outcome: string;
  contentText: string;
  contentHtml: string | null;
  pageCount: number | null;
  ocrRequired: boolean;
  passwordProtected: boolean;
  detail: string | null;
  extractor: string;
  chunks: Chunk[];
};
export type Job = {
  id: string;
  source_id?: string | null;
  sourceId?: string | null;
  status: string;
  error_code?: string | null;
  errorCode?: string | null;
  last_error?: string | null;
  lastError?: string | null;
  retryable?: boolean;
};
export type Annotation = {
  id: string;
  passageId: string;
  quote: string;
  note: string;
  pageNumber: number | null;
  charStart: number | null;
  needsReview: boolean;
  reviewReason: string | null;
};
export type Doc = {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: "note" | "brief";
  title: string;
  bodyHtml: string;
  bodyText: string;
  revision: number;
};
export type SearchResult = {
  query: string;
  indexDelay: string;
  semantic: { status: string; reason: string };
  retrieval?: string;
  results: { resultType: string; passageId: string | null; sourceId: string | null; documentId: string | null; title: string; pageNumber: number | null; snippet: string }[];
};

export interface Client {
  mode: "demo" | "server";
  onChange(listener: () => void): () => void;
  me(): Promise<User | null>;
  register(input: { email: string; name: string; password: string }): Promise<User>;
  login(input: { email: string; password: string }): Promise<User>;
  logout(): Promise<void>;
  capabilities(): Promise<Record<string, unknown>>;
  workspaces(): Promise<Workspace[]>;
  projects(workspaceId: string): Promise<Project[]>;
  createProject(workspaceId: string, name: string): Promise<Project>;
  sources(projectId: string): Promise<Source[]>;
  source(id: string): Promise<{ source: Source; version: Version | null; jobs: Job[] }>;
  uploadNote(projectId: string, title: string, text: string): Promise<void>;
  uploadFile(projectId: string, file: File, title: string): Promise<void>;
  uploadUrl(projectId: string, url: string, title: string): Promise<void>;
  annotations(sourceId: string): Promise<Annotation[]>;
  annotate(sourceId: string, input: { passageId: string; quote: string; note: string; charStart?: number; charEnd?: number; pageNumber?: number | null }): Promise<Annotation>;
  search(projectId: string, q: string): Promise<SearchResult>;
  documents(projectId: string, kind?: string): Promise<Doc[]>;
  document(id: string): Promise<Doc>;
  createDocument(projectId: string, kind: "note" | "brief", title: string): Promise<Doc>;
  saveDocument(id: string, input: { baseRevision: number; title: string; bodyHtml: string }): Promise<Doc>;
  revisions(id: string): Promise<{ revision: number; title: string; authorName: string | null }[]>;
  generate(id: string, input: { instruction: string; baseRevision: number; passageIds?: string[] }): Promise<Record<string, unknown>>;
  shares(documentId: string): Promise<{ id: string; exposeCitedPassages: boolean; revokedAt: string | null; expiresAt: string }[]>;
  createShare(documentId: string, exposeCitedPassages: boolean): Promise<{ id: string; token: string }>;
  revokeShare(id: string): Promise<void>;
  readShared(token: string): Promise<Record<string, unknown>>;
  members(workspaceId: string): Promise<{ id: string; email: string; name: string; role: string }[]>;
  addMember(workspaceId: string, email: string, role: string): Promise<void>;
  jobs(projectId: string): Promise<Job[]>;
  cancelJob(id: string): Promise<void>;
  passages(projectId: string): Promise<{ passageId: string; label: string; sourceId: string }[]>;
  isolationProbe(projectId: string): Promise<{ query: string; hits: number; note: string }>;
}

const FIELD_LOG = `Northglass Basin Field Log 014
Station: Veldtide Gauge
Observer: I. Pell
This log is fictional.

The veldtide gauge recorded a morning stage of 1.84 meters. Dye released at the upper riffle reached the lower footbridge in forty-one minutes. Water temperature was 3.2 C. No ice shelf remained at the gauge pool.

A later line in the same log says the staff asked whether the gauge was re-leveled after the March storm. The log does not name a second instrument.`;

const METHODS = "A note on the dye-trace method at Northglass Basin.\n\nThe carmine dye lot ND-12 was released above the veldtide gauge. This page is fictional and exists so extraction can be inspected.";

function uid(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function snippet(text: string, q: string): string {
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return escapeHtml(text.slice(0, 160));
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + q.length + 60);
  const raw = text.slice(start, end);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return escapeHtml(raw).replace(re, (match) => `<mark>${match}</mark>`);
}

class DemoClient implements Client {
  mode = "demo" as const;
  private listeners = new Set<() => void>();
  private user: User | null = null;
  private workspaceId = "ws_northglass";
  private projectId = "pr_basin";
  private sourceItems: Source[] = [];
  private versions = new Map<string, Version>();
  private jobItems: Job[] = [];
  private annotationItems: Annotation[] = [];
  private docs: Doc[] = [];
  private revisionLog = new Map<string, { revision: number; title: string; bodyHtml: string }[]>();
  private shareItems: { id: string; documentId: string; token: string; expose: boolean; revokedAt: string | null; expiresAt: string }[] = [];
  private memberItems = [
    { id: "user_archivist", email: "archivist@northglass.example", name: "Northglass Archivist", role: "owner" },
  ];
  private timers = new Map<string, number>();

  constructor() {
    const log = this.extracted("src_log", "Field log 014", "note", FIELD_LOG, null);
    const methods = this.extracted("src_methods", "Dye-trace method note", "file", METHODS, [{ pageNumber: 1, charStart: 0, charEnd: METHODS.length }]);
    methods.version.chunks = methods.version.chunks.map((chunk) => ({ ...chunk, pageNumber: 1 }));
    const plate = this.versionShell("src_plate", "ocr_required", "", true, false, "This PDF has no usable text layer. OCR is not implemented in this preview or on the server.");
    this.sourceItems = [log.source, methods.source, {
      id: "src_plate",
      projectId: this.projectId,
      workspaceId: this.workspaceId,
      kind: "file",
      title: "Plate 7",
      outcome: "ocr_required",
      outcomeDetail: plate.detail,
      detectedMime: "application/pdf",
    }];
    this.versions.set(log.source.id, log.version);
    this.versions.set(methods.source.id, methods.version);
    this.versions.set("src_plate", plate);
    const passageId = log.version.chunks[0]?.passageId ?? "psg_0000000000000001";
    const brief: Doc = {
      id: "doc_brief",
      projectId: this.projectId,
      workspaceId: this.workspaceId,
      kind: "brief",
      title: "Stage brief",
      bodyHtml: `<p>The field log names the veldtide gauge. <cite data-passage-id="${passageId}">${passageId}</cite></p>`,
      bodyText: "The field log names the veldtide gauge.",
      revision: 1,
    };
    const note: Doc = {
      id: "doc_note",
      projectId: this.projectId,
      workspaceId: this.workspaceId,
      kind: "note",
      title: "Working note",
      bodyHtml: "<p>Ask whether the gauge was re-leveled after the March storm.</p>",
      bodyText: "Ask whether the gauge was re-leveled after the March storm.",
      revision: 1,
    };
    this.docs = [brief, note];
    this.revisionLog.set(brief.id, [{ revision: 1, title: brief.title, bodyHtml: brief.bodyHtml }]);
    this.revisionLog.set(note.id, [{ revision: 1, title: note.title, bodyHtml: note.bodyHtml }]);
  }

  private extracted(id: string, title: string, kind: string, text: string, pages: { pageNumber: number; charStart: number; charEnd: number }[] | null) {
    const chunks = chunkText(text, pages ?? []).map((chunk, index) => ({
      passageId: `psg_${(index + (id === "src_methods" ? 20 : 1)).toString(16).padStart(16, "0")}`,
      ordinal: chunk.ordinal,
      text: chunk.text,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      pageNumber: chunk.pageNumber,
    }));
    const source: Source = {
      id,
      projectId: this.projectId,
      workspaceId: this.workspaceId,
      kind,
      title,
      outcome: "extracted",
      outcomeDetail: pages ? "Fixture text with a page number taken from the prepared extract." : "Fixture text. No page model, so page positions are absent.",
      detectedMime: kind === "file" ? "application/pdf" : "text/plain",
    };
    const version: Version = {
      id: `ver_${id}`,
      versionNumber: 1,
      outcome: "extracted",
      contentText: text,
      contentHtml: null,
      pageCount: pages ? 1 : null,
      ocrRequired: false,
      passwordProtected: false,
      detail: source.outcomeDetail,
      extractor: "fixture",
      chunks,
    };
    return { source, version };
  }

  private versionShell(id: string, outcome: string, text: string, ocr: boolean, password: boolean, detail: string): Version {
    return {
      id: `ver_${id}`,
      versionNumber: 1,
      outcome,
      contentText: text,
      contentHtml: null,
      pageCount: ocr ? 1 : null,
      ocrRequired: ocr,
      passwordProtected: password,
      detail,
      extractor: "preview",
      chunks: [],
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  async me() { return this.user; }

  async register(input: { email: string; name: string; password: string }) {
    this.user = { id: "user_archivist", email: input.email, name: input.name };
    this.emit();
    return this.user;
  }

  async login(input: { email: string; password: string }) {
    if (input.password.length < 10) throw new ApiError(401, "invalid_login", "Use the preview password printed on the sign-in card.");
    this.user = { id: "user_archivist", email: input.email || "archivist@northglass.example", name: "Northglass Archivist" };
    this.emit();
    return this.user;
  }

  async logout() { this.user = null; this.emit(); }

  async capabilities() {
    return {
      capabilities: STATIC_CAPABILITIES,
      collaboration: COLLABORATION,
      semantic: SEMANTIC_RETRIEVAL,
      disclosure: AI_DISCLOSURE,
      runtime: { ai: "unavailable", semantic: "unavailable", search: "preview_substring", collaboration: "optimistic_concurrency", realtime: "unavailable", ocr: "unavailable", storage: "browser_memory" },
      preview: "This page is a browser preview. Postgres, private object storage, the durable worker, and SSRF-protected fetch run only in the server deployment.",
    };
  }

  async workspaces() {
    return [{ id: this.workspaceId, name: "Northglass", role: "owner" }];
  }

  async projects() {
    return [{ id: this.projectId, name: "Northglass Basin", description: "Fictional field notes.", role: "owner" }];
  }

  async createProject(_workspaceId: string, name: string) {
    return { id: this.projectId, name, role: "owner" };
  }

  async sources() { return this.sourceItems; }

  async source(id: string) {
    const source = this.sourceItems.find((item) => item.id === id);
    if (!source) throw new ApiError(404, "not_found", "Source not found");
    return { source, version: this.versions.get(id) ?? null, jobs: this.jobItems.filter((job) => (job.sourceId ?? job.source_id) === id) };
  }

  async uploadNote(projectId: string, title: string, text: string) {
    this.queueText(projectId, title || text.split("\n")[0] || "Note", "note", text);
  }

  async uploadFile(projectId: string, file: File, title: string) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = String.fromCharCode(...bytes.slice(0, 5));
    if (header === "%PDF-") {
      await this.queuePdf(projectId, title || file.name, bytes);
      return;
    }
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ApiError(400, "mime_mismatch", "This preview accepts UTF-8 text and text-based PDFs.");
    }
    this.queueText(projectId, title || file.name, "file", text);
  }

  async uploadUrl() {
    throw new ApiError(503, "preview_limitation", "Public page fetch, including SSRF checks, runs on the server. This preview does not fetch URLs.");
  }

  private queueText(projectId: string, title: string, kind: string, text: string) {
    const id = uid("src").slice(0, 12);
    const source: Source = {
      id,
      projectId,
      workspaceId: this.workspaceId,
      kind,
      title,
      outcome: "pending",
      outcomeDetail: "Queued in this browser preview. This is not the durable worker.",
    };
    this.sourceItems = [source, ...this.sourceItems];
    const job: Job = { id: uid("job"), sourceId: id, status: "queued", retryable: true };
    this.jobItems = [job, ...this.jobItems];
    this.emit();
    const timer = window.setTimeout(() => {
      if (job.status === "cancelled") return;
      job.status = "completed";
      const built = this.extracted(id, title, kind, text, null);
      source.outcome = "extracted";
      source.outcomeDetail = "Extracted in this browser tab. It will disappear on refresh.";
      this.versions.set(id, { ...built.version, extractor: "preview-utf8" });
      this.emit();
    }, 450);
    this.timers.set(job.id, timer);
  }

  private async queuePdf(projectId: string, title: string, bytes: Uint8Array) {
    const id = uid("src").slice(0, 12);
    const source: Source = {
      id,
      projectId,
      workspaceId: this.workspaceId,
      kind: "file",
      title,
      outcome: "pending",
      outcomeDetail: "Reading the PDF in this browser. Nothing is stored on a server.",
    };
    this.sourceItems = [source, ...this.sourceItems];
    const job: Job = { id: uid("job"), sourceId: id, status: "processing", retryable: false };
    this.jobItems = [job, ...this.jobItems];
    this.emit();
    try {
      const unpdf = await import("unpdf");
      const pdf = await unpdf.getDocumentProxy(bytes);
      const extracted = await unpdf.extractText(pdf, { mergePages: false });
      const pages = extracted.text.map((page) => page ?? "");
      const alnum = pages.join(" ").match(/[A-Za-z0-9]/g)?.length ?? 0;
      if (alnum < 20) {
        source.outcome = "ocr_required";
        source.outcomeDetail = "No usable text layer. OCR is not available, so no text was invented.";
        this.versions.set(id, this.versionShell(id, "ocr_required", "", true, false, source.outcomeDetail));
      } else {
        const joined = joinPages(pages);
        const built = this.extracted(id, title, "file", joined.text, joined.pages);
        source.outcome = "extracted";
        source.outcomeDetail = "Extracted in this browser with unpdf. The durable server pipeline is separate.";
        this.versions.set(id, { ...built.version, extractor: "unpdf-browser" });
      }
      job.status = "completed";
      await pdf.destroy();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "PasswordException") {
        source.outcome = "password_protected";
        source.outcomeDetail = "This PDF asks for a password. The preview does not collect one.";
        this.versions.set(id, this.versionShell(id, "password_protected", "", false, true, source.outcomeDetail));
        job.status = "failed";
        job.errorCode = "password_protected";
      } else {
        source.outcome = "failed";
        source.outcomeDetail = "The browser could not extract that PDF.";
        job.status = "failed";
      }
    }
    this.emit();
  }

  async annotations(sourceId: string) { return this.annotationItems.filter((item) => item.id && this.annotationSource(item.id) === sourceId || this.annotationSource(item.id) === sourceId); }

  private annotationSource(id: string) {
    return this.annotationIndex.get(id) ?? "";
  }

  private annotationIndex = new Map<string, string>();

  async annotate(sourceId: string, input: { passageId: string; quote: string; note: string; charStart?: number; charEnd?: number; pageNumber?: number | null }) {
    const version = this.versions.get(sourceId);
    const chunk = version?.chunks.find((item) => item.passageId === input.passageId);
    if (!chunk) throw new ApiError(400, "unknown_citation", "That passage is not on this source");
    if (input.pageNumber != null && input.pageNumber !== chunk.pageNumber) {
      throw new ApiError(400, "page_unknown", "That page number was not produced by extraction");
    }
    const annotation: Annotation = {
      id: uid("ann"),
      passageId: input.passageId,
      quote: input.quote,
      note: input.note,
      pageNumber: chunk.pageNumber,
      charStart: input.charStart ?? null,
      needsReview: false,
      reviewReason: null,
    };
    this.annotationIndex.set(annotation.id, sourceId);
    this.annotationItems.push(annotation);
    this.emit();
    return annotation;
  }

  async search(projectId: string, q: string): Promise<SearchResult> {
    const query = q.trim();
    const results: SearchResult["results"] = [];
    if (projectId === this.projectId) {
      for (const source of this.sourceItems) {
        const version = this.versions.get(source.id);
        for (const chunk of version?.chunks ?? []) {
          if (chunk.text.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              resultType: "passage",
              passageId: chunk.passageId,
              sourceId: source.id,
              documentId: null,
              title: source.title,
              pageNumber: chunk.pageNumber,
              snippet: snippet(chunk.text, query),
            });
          }
        }
      }
    }
    return {
      query,
      retrieval: "preview_substring",
      semantic: SEMANTIC_RETRIEVAL,
      indexDelay: "This preview searches text already loaded in the tab. It is not Postgres full-text search. The server index updates when a job completes, and OCR-required files have no text to find.",
      results,
    };
  }

  async documents(projectId: string, kind?: string) {
    return this.docs.filter((doc) => doc.projectId === projectId && (!kind || doc.kind === kind));
  }

  async document(id: string) {
    const doc = this.docs.find((item) => item.id === id);
    if (!doc) throw new ApiError(404, "not_found", "Document not found");
    return doc;
  }

  async createDocument(projectId: string, kind: "note" | "brief", title: string) {
    const doc: Doc = { id: uid("doc"), projectId, workspaceId: this.workspaceId, kind, title, bodyHtml: "<p></p>", bodyText: "", revision: 1 };
    this.docs = [doc, ...this.docs];
    this.revisionLog.set(doc.id, [{ revision: 1, title, bodyHtml: doc.bodyHtml }]);
    this.emit();
    return doc;
  }

  async saveDocument(id: string, input: { baseRevision: number; title: string; bodyHtml: string }) {
    const doc = await this.document(id);
    if (doc.revision !== input.baseRevision) {
      throw new ApiError(409, "revision_conflict", "Someone saved this document after your copy. Your save was not applied.", { document: doc });
    }
    doc.revision += 1;
    doc.title = input.title;
    doc.bodyHtml = input.bodyHtml;
    doc.bodyText = input.bodyHtml.replace(/<[^>]+>/g, " ");
    this.revisionLog.get(id)?.push({ revision: doc.revision, title: doc.title, bodyHtml: doc.bodyHtml });
    this.emit();
    return doc;
  }

  async revisions(id: string) {
    return (this.revisionLog.get(id) ?? []).map((row) => ({ revision: row.revision, title: row.title, authorName: "You" })).reverse();
  }

  async generate(id: string, input: { instruction: string; baseRevision: number }): Promise<Record<string, unknown>> {
    const doc = await this.document(id);
    if (doc.revision !== input.baseRevision) {
      throw new ApiError(409, "revision_conflict", "The brief changed. Nothing was generated.", { document: doc });
    }
    const flags = reviewDraft("No model is configured, so this sentence is not a generated brief.", new Set());
    throw new ApiError(503, "ai_unavailable", "No AI provider is configured. The brief was not changed.", {
      disclosure: AI_DISCLOSURE,
      flags,
    });
  }

  async shares(documentId: string) {
    return this.shareItems.filter((share) => share.documentId === documentId).map((share) => ({
      id: share.id,
      exposeCitedPassages: share.expose,
      revokedAt: share.revokedAt,
      expiresAt: share.expiresAt,
    }));
  }

  async createShare(documentId: string, exposeCitedPassages: boolean) {
    const share = {
      id: uid("share"),
      documentId,
      token: uid("token"),
      expose: exposeCitedPassages,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    this.shareItems.push(share);
    this.emit();
    return { id: share.id, token: share.token };
  }

  async revokeShare(id: string) {
    const share = this.shareItems.find((item) => item.id === id);
    if (!share) throw new ApiError(404, "not_found", "Share link not found");
    share.revokedAt = new Date().toISOString();
    this.emit();
  }

  async readShared(token: string) {
    const share = this.shareItems.find((item) => item.token === token);
    if (!share) throw new ApiError(404, "not_found", "Share link not found");
    if (share.revokedAt) throw new ApiError(403, "share_revoked", "This share link has been revoked");
    const doc = await this.document(share.documentId);
    const html = share.expose ? doc.bodyHtml : doc.bodyHtml.replace(/<cite\b[^>]*>[\s\S]*?<\/cite>/gi, "<sup>citation</sup>").replace(/psg_[a-f0-9]{16}/g, "citation");
    let citations: { quote: string; sourceTitle: string; pageNumber: number | null }[] = [];
    if (share.expose) {
      const id = doc.bodyHtml.match(/psg_[a-f0-9]{16}/)?.[0];
      for (const version of this.versions.values()) {
        const chunk = version.chunks.find((item) => item.passageId === id);
        if (chunk) citations = [{ quote: chunk.text, sourceTitle: "Cited passage", pageNumber: chunk.pageNumber }];
      }
    }
    return {
      title: doc.title,
      bodyHtml: html,
      exposeCitedPassages: share.expose,
      citations,
      notice: share.expose
        ? "Preview link includes the cited passage text only."
        : "Preview link shows the brief only. Passage identifiers were removed.",
    };
  }

  async members() { return this.memberItems; }

  async addMember(_workspaceId: string, email: string, role: string) {
    this.memberItems.push({ id: uid("user"), email, name: email, role });
    this.emit();
  }

  async jobs() { return this.jobItems; }

  async cancelJob(id: string) {
    const job = this.jobItems.find((item) => item.id === id);
    if (!job) return;
    job.status = "cancelled";
    const timer = this.timers.get(id);
    if (timer) window.clearTimeout(timer);
    this.emit();
  }

  async passages() {
    const rows: { passageId: string; label: string; sourceId: string }[] = [];
    for (const source of this.sourceItems) {
      for (const chunk of this.versions.get(source.id)?.chunks ?? []) {
        rows.push({ passageId: chunk.passageId, sourceId: source.id, label: `${source.title}: ${chunk.text.slice(0, 80)}` });
      }
    }
    return rows;
  }

  async isolationProbe() {
    const hits = (await this.search(this.projectId, "lumenquartz")).results.length;
    return {
      query: "lumenquartz",
      hits,
      note: "lumenquartz is a fictional token that exists only in the other workspace used by the server test. This preview cannot see it, and the server test checks that a second workspace cannot search it either.",
    };
  }
}

class ServerClient implements Client {
  mode = "server" as const;
  onChange() { return () => undefined; }

  private async send(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...init, headers, credentials: "include" });
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) {
      throw new ApiError(response.status, String(body.error ?? "error"), String(body.message ?? "Request failed"), body.details);
    }
    return body;
  }

  async me() {
    try {
      const body = await this.send("/api/me");
      return body.user as User;
    } catch {
      return null;
    }
  }
  async register(input: { email: string; name: string; password: string }) {
    const body = await this.send("/api/auth/register", { method: "POST", body: JSON.stringify(input) });
    return body.user as User;
  }
  async login(input: { email: string; password: string }) {
    const body = await this.send("/api/auth/login", { method: "POST", body: JSON.stringify(input) });
    return body.user as User;
  }
  async logout() { await this.send("/api/auth/logout", { method: "POST" }); }
  async capabilities() { return this.send("/api/capabilities"); }
  async workspaces() {
    const body = await this.send("/api/workspaces");
    return body.workspaces as Workspace[];
  }
  async projects(workspaceId: string) {
    const body = await this.send(`/api/workspaces/${workspaceId}/projects`);
    return (body.projects as Project[]).map((project) => ({ ...project, workspaceId }));
  }
  async createProject(workspaceId: string, name: string) {
    const body = await this.send(`/api/workspaces/${workspaceId}/projects`, { method: "POST", body: JSON.stringify({ name, description: "" }) });
    return body.project as Project;
  }
  async sources(projectId: string) {
    const body = await this.send(`/api/projects/${projectId}/sources`);
    return body.sources as Source[];
  }
  async source(id: string) {
    return this.send(`/api/sources/${id}`) as Promise<{ source: Source; version: Version | null; jobs: Job[] }>;
  }
  async uploadNote(projectId: string, title: string, text: string) {
    await this.send(`/api/projects/${projectId}/sources/note`, { method: "POST", body: JSON.stringify({ title, text }) });
  }
  async uploadFile(projectId: string, file: File, title: string) {
    const form = new FormData();
    form.set("file", file);
    form.set("title", title);
    await this.send(`/api/projects/${projectId}/sources/file`, { method: "POST", body: form });
  }
  async uploadUrl(projectId: string, url: string, title: string) {
    await this.send(`/api/projects/${projectId}/sources/url`, { method: "POST", body: JSON.stringify({ url, title }) });
  }
  async annotations(sourceId: string) {
    const body = await this.send(`/api/sources/${sourceId}/annotations`);
    return body.annotations as Annotation[];
  }
  async annotate(sourceId: string, input: { passageId: string; quote: string; note: string; charStart?: number; charEnd?: number; pageNumber?: number | null }) {
    const body = await this.send(`/api/sources/${sourceId}/annotations`, { method: "POST", body: JSON.stringify(input) });
    return body.annotation as Annotation;
  }
  async search(projectId: string, q: string) {
    return this.send(`/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`) as Promise<SearchResult>;
  }
  async documents(projectId: string, kind?: string) {
    const body = await this.send(`/api/projects/${projectId}/documents${kind ? `?kind=${kind}` : ""}`);
    return body.documents as Doc[];
  }
  async document(id: string) {
    const body = await this.send(`/api/documents/${id}`);
    return body.document as Doc;
  }
  async createDocument(projectId: string, kind: "note" | "brief", title: string) {
    const body = await this.send(`/api/projects/${projectId}/documents`, { method: "POST", body: JSON.stringify({ kind, title, bodyHtml: "<p></p>" }) });
    return body.document as Doc;
  }
  async saveDocument(id: string, input: { baseRevision: number; title: string; bodyHtml: string }) {
    const body = await this.send(`/api/documents/${id}`, { method: "PATCH", body: JSON.stringify(input) });
    return body.document as Doc;
  }
  async revisions(id: string) {
    const body = await this.send(`/api/documents/${id}/revisions`);
    return body.revisions as { revision: number; title: string; authorName: string | null }[];
  }
  async generate(id: string, input: { instruction: string; baseRevision: number; passageIds?: string[] }) {
    return this.send(`/api/documents/${id}/generate`, { method: "POST", body: JSON.stringify({ ...input, apply: false }) });
  }
  async shares(documentId: string) {
    const body = await this.send(`/api/documents/${documentId}/shares`);
    return (body.shares as { id: string; expose_cited_passages: boolean; revoked_at: string | null; expires_at: string }[]).map((share) => ({
      id: share.id,
      exposeCitedPassages: share.expose_cited_passages,
      revokedAt: share.revoked_at,
      expiresAt: share.expires_at,
    }));
  }
  async createShare(documentId: string, exposeCitedPassages: boolean) {
    const body = await this.send(`/api/documents/${documentId}/shares`, {
      method: "POST",
      body: JSON.stringify({ days: 7, exposeCitedPassages }),
    });
    return body.share as { id: string; token: string };
  }
  async revokeShare(id: string) { await this.send(`/api/shares/${id}/revoke`, { method: "POST" }); }
  async readShared(token: string) { return this.send(`/api/shared/${token}`); }
  async members(workspaceId: string) {
    const body = await this.send(`/api/workspaces/${workspaceId}/members`);
    return body.members as { id: string; email: string; name: string; role: string }[];
  }
  async addMember(workspaceId: string, email: string, role: string) {
    await this.send(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: JSON.stringify({ email, role }) });
  }
  async jobs(projectId: string) {
    const body = await this.send(`/api/projects/${projectId}/jobs`);
    return body.jobs as Job[];
  }
  async cancelJob(id: string) { await this.send(`/api/jobs/${id}/cancel`, { method: "POST" }); }
  async passages(projectId: string) {
    const sources = await this.sources(projectId);
    const rows: { passageId: string; label: string; sourceId: string }[] = [];
    for (const source of sources.slice(0, 12)) {
      const detail = await this.source(source.id);
      for (const chunk of detail.version?.chunks ?? []) {
        rows.push({ passageId: chunk.passageId, sourceId: source.id, label: `${source.title}: ${chunk.text.slice(0, 80)}` });
      }
    }
    return rows;
  }
  async isolationProbe(projectId: string) {
    const result = await this.search(projectId, "lumenquartz");
    return {
      query: "lumenquartz",
      hits: result.results.length,
      note: "A zero means this project cannot see that token. The automated test also signs in as a different workspace and checks the private source id returns not found.",
    };
  }
}

export function createClient(): Client {
  if (import.meta.env.VITE_DEMO_MODE === "true") return new DemoClient();
  return new ServerClient();
}
