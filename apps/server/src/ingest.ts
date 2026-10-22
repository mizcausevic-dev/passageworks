import { randomUUID } from "node:crypto";
import { detectKind, LIMITS } from "../../../packages/domain/src/index.ts";
import type { Ctx } from "./ctx.ts";
import { HttpError, IngestError, JobCancelled } from "./errors.ts";
import { extractWithLimit, type Extraction } from "./extract.ts";
import { assertPublicUrl, isBlockedIp, safeFetch } from "./ssrf.ts";
import { asJson, cleanTitle, newPassageId, sha256, shortError } from "./util.ts";

type SourceRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  kind: "file" | "url" | "note";
  title: string;
  original_filename: string | null;
  declared_mime: string | null;
  detected_mime: string | null;
  byte_size: number | null;
  storage_key: string | null;
  origin_url: string | null;
  outcome: string | null;
  outcome_detail: string | null;
  current_version_id: string | null;
  raw_sha256: string | null;
  created_at: Date | string;
  ingested_at: Date | string | null;
  deleted_at: Date | string | null;
  metadata: Record<string, unknown>;
};

type JobRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  source_id: string | null;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  retryable: boolean;
  cancel_requested: boolean;
  error_code: string | null;
  last_error: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

export async function createStoredSource(
  ctx: Ctx,
  input: {
    workspaceId: string;
    projectId: string;
    userId: string;
    kind: "file" | "note";
    title: string;
    filename: string | null;
    declaredMime: string | null;
    bytes: Uint8Array;
  },
): Promise<{ sourceId: string; jobId: string }> {
  if (input.bytes.byteLength === 0) throw new HttpError(400, "empty_source", "The source is empty");
  if (input.bytes.byteLength > LIMITS.maxFileBytes) {
    throw new HttpError(413, "too_large", "The file exceeds the 15 MB limit");
  }
  const sniffed = detectKind(input.bytes, input.declaredMime);
  if (sniffed !== "pdf" && sniffed !== "text") {
    throw new HttpError(400, "mime_mismatch", "The file contents are not UTF-8 text or a PDF. The filename is not used as proof.");
  }
  const key = randomUUID();
  await ctx.storage.put(key, input.bytes);
  return insertQueuedSource(ctx, {
    ...input,
    storageKey: key,
    originUrl: null,
    byteSize: input.bytes.byteLength,
    metadata: { live_fetch: false },
  });
}

export async function createUrlSource(
  ctx: Ctx,
  input: { workspaceId: string; projectId: string; userId: string; url: string; title?: string },
): Promise<{ sourceId: string; jobId: string }> {
  let url: URL;
  try {
    url = assertPublicUrl(input.url);
    if (!literalHost(url.hostname)) {
      let records: { address: string; family: number }[];
      try {
        records = await ctx.lookup(url.hostname);
      } catch {
        throw new HttpError(400, "dns_failed", "DNS lookup failed");
      }
      if (records.length === 0) throw new HttpError(400, "dns_failed", "DNS lookup returned no addresses");
      for (const record of records) {
        const family = record.family === 6 ? 6 : 4;
        if (isBlockedIp(record.address, family)) {
          throw new HttpError(400, "ssrf_blocked", "DNS resolved to a non-public address");
        }
      }
    }
  } catch (error) {
    if (error instanceof IngestError) throw new HttpError(400, error.code, error.message);
    throw error;
  }
  return insertQueuedSource(ctx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    userId: input.userId,
    kind: "url",
    title: cleanTitle(input.title, url.hostname),
    filename: null,
    declaredMime: null,
    storageKey: null,
    originUrl: url.href,
    byteSize: null,
    metadata: { requested_url: url.href, live_fetch: true },
  });
}

function literalHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

async function insertQueuedSource(
  ctx: Ctx,
  input: {
    workspaceId: string;
    projectId: string;
    userId: string;
    kind: "file" | "url" | "note";
    title: string;
    filename: string | null;
    declaredMime: string | null;
    storageKey: string | null;
    originUrl: string | null;
    byteSize: number | null;
    metadata: Record<string, unknown>;
  },
): Promise<{ sourceId: string; jobId: string }> {
  const created = await ctx.db.tx(async (db) => {
    const sources = await db.query<{ id: string }>(
      `INSERT INTO sources (
         workspace_id, project_id, kind, title, original_filename, declared_mime, byte_size,
         storage_key, origin_url, outcome, created_by, metadata, raw_sha256
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11::jsonb, $12
       ) RETURNING id`,
      [
        input.workspaceId,
        input.projectId,
        input.kind,
        input.title,
        input.filename,
        input.declaredMime,
        input.byteSize,
        input.storageKey,
        input.originUrl,
        input.userId,
        asJson(input.metadata),
        null,
      ],
    );
    const sourceId = sources[0]?.id;
    if (!sourceId) throw new HttpError(500, "internal", "Could not store the source");
    const jobs = await db.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, project_id, source_id, type, status, max_attempts, payload)
       VALUES ($1, $2, $3, 'ingest', 'queued', $4, '{}'::jsonb)
       RETURNING id`,
      [input.workspaceId, input.projectId, sourceId, LIMITS.jobMaxAttempts],
    );
    const jobId = jobs[0]?.id;
    if (!jobId) throw new HttpError(500, "internal", "Could not queue ingestion");
    return { sourceId, jobId };
  });
  return created;
}

export async function processNext(ctx: Ctx): Promise<boolean> {
  await recoverStale(ctx);
  const claimed = await ctx.db.tx(async (db) => {
    const rows = await db.query<JobRow>(
      `UPDATE jobs SET
         status = 'processing',
         locked_at = now(),
         locked_by = $1,
         attempts = attempts + 1,
         updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= now() AND cancel_requested = false
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, workspace_id, project_id, source_id, type, status, attempts, max_attempts,
                 retryable, cancel_requested, error_code, last_error, payload, created_at, finished_at`,
      [ctx.workerId],
    );
    return rows[0] ?? null;
  });
  if (!claimed) return false;
  try {
    await runIngest(ctx, claimed);
  } catch (error) {
    if (error instanceof JobCancelled) {
      await markCancelled(ctx, claimed.id);
      return true;
    }
    await failJob(ctx, claimed, error);
  }
  return true;
}

async function runIngest(ctx: Ctx, job: JobRow): Promise<void> {
  const already = await ctx.db.query<{ id: string }>(`SELECT id FROM source_versions WHERE job_id = $1`, [job.id]);
  if (already[0]) {
    await markCompleted(ctx, job.id);
    return;
  }
  if (!job.source_id) throw new IngestError("source_missing", false, "Job has no source");
  const sources = await ctx.db.query<SourceRow>(`SELECT * FROM sources WHERE id = $1`, [job.source_id]);
  const source = sources[0];
  if (!source || source.deleted_at) throw new IngestError("source_missing", false, "Source is gone");
  let bytes: Uint8Array;
  let header = source.declared_mime;
  const metadata = isRecord(source.metadata) ? { ...source.metadata } : {};
  if (source.kind === "url") {
    if (!source.origin_url) throw new IngestError("invalid_url", false, "The source has no URL");
    const fetched = await safeFetch(source.origin_url, { fetchImpl: ctx.fetchImpl, lookup: ctx.lookup });
    bytes = fetched.body;
    header = fetched.contentType;
    const key = randomUUID();
    await ctx.storage.put(key, bytes);
    metadata.final_url = fetched.finalUrl;
    metadata.http_status = fetched.status;
    metadata.content_type = fetched.contentType.slice(0, 200);
    await ctx.db.query(
      `UPDATE sources SET storage_key = $2, byte_size = $3, metadata = $4::jsonb WHERE id = $1`,
      [source.id, key, bytes.byteLength, asJson(metadata)],
    );
    source.storage_key = key;
  } else {
    if (!source.storage_key) throw new IngestError("missing_object", false, "The stored file is missing");
    bytes = await ctx.storage.get(source.storage_key);
  }
  if (bytes.byteLength > LIMITS.maxFileBytes) {
    throw new IngestError("too_large", false, "The file exceeds the 15 MB limit");
  }
  const sniffed = detectKind(bytes, header);
  if (source.kind === "url") {
    if (sniffed !== "html" && sniffed !== "text" && sniffed !== "pdf") {
      throw new IngestError("unsupported_type", false, "The response is not HTML, plain text, or a PDF");
    }
  } else if (sniffed !== "text" && sniffed !== "pdf") {
    throw new IngestError("mime_mismatch", false, "The file contents are not UTF-8 text or a PDF");
  }
  const extraction = await extractWithLimit(bytes, sniffed === "html" ? "html" : sniffed);
  if (extraction.extractedTitle) metadata.extracted_title = extraction.extractedTitle.slice(0, 200);
  if (ctx.beforePersist) await ctx.beforePersist(job.id);
  await commitExtraction(ctx, source, job, bytes, extraction, metadata);
}

async function commitExtraction(
  ctx: Ctx,
  source: SourceRow,
  job: JobRow,
  bytes: Uint8Array,
  extraction: Extraction,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ctx.db.tx(async (db) => {
    const state = await db.query<{ cancel_requested: boolean; status: string }>(
      `SELECT cancel_requested, status FROM jobs WHERE id = $1 FOR UPDATE`,
      [job.id],
    );
    if (!state[0] || state[0].status !== "processing" || state[0].cancel_requested) throw new JobCancelled();
    const numbers = await db.query<{ n: number }>(
      `SELECT coalesce(max(version_number), 0) + 1 AS n FROM source_versions WHERE source_id = $1`,
      [source.id],
    );
    const versionNumber = Number(numbers[0]?.n ?? 1);
    const versions = await db.query<{ id: string }>(
      `INSERT INTO source_versions (
         source_id, job_id, version_number, extraction_method, outcome, content_text, content_html,
         page_count, ocr_required, password_protected, detail, content_sha256, extractor
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       ) RETURNING id`,
      [
        source.id,
        job.id,
        versionNumber,
        extraction.method,
        extraction.outcome,
        extraction.contentText,
        extraction.contentHtml,
        extraction.pageCount,
        extraction.ocrRequired,
        extraction.passwordProtected,
        extraction.detail,
        sha256(extraction.contentText),
        extraction.extractor,
      ],
    );
    const versionId = versions[0]?.id;
    if (!versionId) throw new IngestError("ingest_failed", true, "Could not store the extraction");
    for (const page of extraction.pages) {
      await db.query(
        `INSERT INTO pages (source_version_id, page_number, char_start, char_end, text_chars)
         VALUES ($1, $2, $3, $4, $5)`,
        [versionId, page.pageNumber, page.charStart, page.charEnd, page.textChars],
      );
    }
    for (const chunk of extraction.chunks) {
      await db.query(
        `INSERT INTO chunks (
           workspace_id, project_id, source_id, source_version_id, ordinal, passage_id, text,
           char_start, char_end, page_number
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          source.workspace_id,
          source.project_id,
          source.id,
          versionId,
          chunk.ordinal,
          newPassageId(),
          chunk.text,
          chunk.charStart,
          chunk.charEnd,
          chunk.pageNumber,
        ],
      );
    }
    await db.query(
      `UPDATE annotations
       SET needs_review = true, review_reason = 'source_version_changed', updated_at = now()
       WHERE source_id = $1 AND source_version_id <> $2 AND deleted_at IS NULL`,
      [source.id, versionId],
    );
    await db.query(
      `UPDATE sources SET
         detected_mime = $2,
         outcome = $3,
         outcome_detail = $4,
         current_version_id = $5,
         raw_sha256 = $6,
         ingested_at = now(),
         metadata = $7::jsonb,
         byte_size = $8
       WHERE id = $1`,
      [
        source.id,
        extraction.detectedMime,
        extraction.outcome,
        extraction.detail,
        versionId,
        sha256(bytes),
        asJson(metadata),
        bytes.byteLength,
      ],
    );
    if (extraction.outcome === "password_protected") {
      await db.query(
        `UPDATE jobs SET
           status = 'failed', retryable = false, error_code = 'password_protected', last_error = $2,
           finished_at = now(), locked_at = null, updated_at = now()
         WHERE id = $1`,
        [job.id, extraction.detail],
      );
      return;
    }
    await db.query(
      `UPDATE jobs SET
         status = 'completed', error_code = null, last_error = null, finished_at = now(),
         locked_at = null, updated_at = now()
       WHERE id = $1`,
      [job.id],
    );
  });
}

async function recoverStale(ctx: Ctx): Promise<void> {
  const seconds = Math.floor(LIMITS.staleLockMs / 1000);
  await ctx.db.query(
    `UPDATE jobs SET status = 'queued', locked_at = null, locked_by = null, updated_at = now()
     WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 second')
       AND attempts < max_attempts`,
    [seconds],
  );
  await ctx.db.query(
    `UPDATE jobs SET status = 'failed', retryable = false, error_code = 'stale_lock',
       last_error = 'The worker stopped before finishing', finished_at = now(), updated_at = now()
     WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 second')
       AND attempts >= max_attempts`,
    [seconds],
  );
}

async function markCompleted(ctx: Ctx, jobId: string): Promise<void> {
  await ctx.db.query(
    `UPDATE jobs SET status = 'completed', finished_at = now(), locked_at = null, updated_at = now()
     WHERE id = $1 AND status = 'processing'`,
    [jobId],
  );
}

async function markCancelled(ctx: Ctx, jobId: string): Promise<void> {
  await ctx.db.query(
    `UPDATE jobs SET status = 'cancelled', finished_at = now(), locked_at = null, updated_at = now(),
       error_code = 'cancelled'
     WHERE id = $1 AND status = 'processing'`,
    [jobId],
  );
}

async function failJob(ctx: Ctx, job: JobRow, error: unknown): Promise<void> {
  const ingest = error instanceof IngestError ? error : null;
  const code = ingest?.code ?? "ingest_failed";
  const retryable = ingest ? ingest.retryable : true;
  const message = shortError(error);
  const giveUp = !retryable || job.attempts >= job.max_attempts;
  if (giveUp) {
    await ctx.db.query(
      `UPDATE jobs SET status = 'failed', retryable = $2, error_code = $3, last_error = $4,
         finished_at = now(), locked_at = null, updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [job.id, retryable, code, message],
    );
    if (job.source_id) {
      await ctx.db.query(
        `UPDATE sources SET outcome = CASE WHEN current_version_id IS NULL THEN 'failed' ELSE outcome END,
           outcome_detail = $2
         WHERE id = $1`,
        [job.source_id, message],
      );
    }
  } else {
    const seconds = Math.max(0, Math.ceil(ctx.backoffMs(job.attempts) / 1000));
    await ctx.db.query(
      `UPDATE jobs SET status = 'queued', error_code = $2, last_error = $3, locked_at = null, locked_by = null,
         run_after = now() + ($4::int * interval '1 second'), updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [job.id, code, message, seconds],
    );
  }
  console.log(JSON.stringify({ event: "job_failed", jobId: job.id, code, willRetry: !giveUp }));
}

export async function cancelJob(ctx: Ctx, jobId: string, workspaceId: string): Promise<{ status: string }> {
  const rows = await ctx.db.query<{ id: string; status: string }>(
    `SELECT id, status FROM jobs WHERE id = $1 AND workspace_id = $2`,
    [jobId, workspaceId],
  );
  const job = rows[0];
  if (!job) throw new HttpError(404, "not_found", "Job not found");
  if (job.status === "queued") {
    await ctx.db.query(
      `UPDATE jobs SET status = 'cancelled', cancel_requested = true, finished_at = now(), updated_at = now(),
         error_code = 'cancelled'
       WHERE id = $1 AND status = 'queued'`,
      [jobId],
    );
    return { status: "cancelled" };
  }
  if (job.status === "processing") {
    await ctx.db.query(`UPDATE jobs SET cancel_requested = true, updated_at = now() WHERE id = $1`, [jobId]);
    return { status: "cancel_requested" };
  }
  throw new HttpError(409, "job_finished", "That job is already finished");
}

export async function retryJob(ctx: Ctx, jobId: string, workspaceId: string): Promise<{ status: string }> {
  const rows = await ctx.db.query<{ status: string; retryable: boolean }>(
    `SELECT status, retryable FROM jobs WHERE id = $1 AND workspace_id = $2`,
    [jobId, workspaceId],
  );
  const job = rows[0];
  if (!job) throw new HttpError(404, "not_found", "Job not found");
  if (job.status !== "failed") throw new HttpError(409, "job_not_failed", "Only a failed job can be retried");
  if (!job.retryable) throw new HttpError(409, "not_retryable", "This failure will not change if the same input is run again");
  await ctx.db.query(
    `UPDATE jobs SET status = 'queued', attempts = 0, run_after = now(), cancel_requested = false,
       locked_at = null, locked_by = null, last_error = null, error_code = null, finished_at = null, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
  return { status: "queued" };
}

export async function reprocessSource(ctx: Ctx, sourceId: string, workspaceId: string): Promise<{ jobId: string }> {
  const rows = await ctx.db.query<{ id: string; project_id: string; kind: string; deleted_at: string | null }>(
    `SELECT id, project_id, kind, deleted_at FROM sources WHERE id = $1 AND workspace_id = $2`,
    [sourceId, workspaceId],
  );
  const source = rows[0];
  if (!source || source.deleted_at) throw new HttpError(404, "not_found", "Source not found");
  try {
    const jobs = await ctx.db.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, project_id, source_id, type, status, max_attempts, payload)
       VALUES ($1, $2, $3, 'ingest', 'queued', $4, '{}'::jsonb) RETURNING id`,
      [workspaceId, source.project_id, source.id, LIMITS.jobMaxAttempts],
    );
    const jobId = jobs[0]?.id;
    if (!jobId) throw new HttpError(500, "internal", "Could not queue ingestion");
    return { jobId };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "job_active", "This source already has a queued or running job");
  }
}

export async function loadSource(ctx: Ctx, sourceId: string, workspaceId: string): Promise<SourceRow> {
  const rows = await ctx.db.query<SourceRow>(
    `SELECT * FROM sources WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [sourceId, workspaceId],
  );
  const source = rows[0];
  if (!source) throw new HttpError(404, "not_found", "Source not found");
  return source;
}

export async function listSources(ctx: Ctx, projectId: string): Promise<SourceRow[]> {
  return ctx.db.query<SourceRow>(
    `SELECT * FROM sources WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [projectId],
  );
}

export async function listJobs(ctx: Ctx, projectId: string): Promise<JobRow[]> {
  return ctx.db.query<JobRow>(
    `SELECT id, workspace_id, project_id, source_id, type, status, attempts, max_attempts, retryable,
            cancel_requested, error_code, last_error, payload, created_at, finished_at
     FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [projectId],
  );
}

export async function softDeleteSource(ctx: Ctx, sourceId: string, workspaceId: string): Promise<void> {
  const rows = await ctx.db.query<{ storage_key: string | null }>(
    `UPDATE sources SET deleted_at = now()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
     RETURNING storage_key`,
    [sourceId, workspaceId],
  );
  if (!rows[0]) throw new HttpError(404, "not_found", "Source not found");
  await ctx.db.query(
    `UPDATE jobs SET status = 'cancelled', cancel_requested = true, finished_at = now(), updated_at = now(),
       error_code = 'cancelled'
     WHERE source_id = $1 AND status = 'queued'`,
    [sourceId],
  );
  await ctx.db.query(
    `UPDATE annotations SET needs_review = true, review_reason = 'source_deleted', updated_at = now()
     WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  if (rows[0].storage_key) await ctx.storage.delete(rows[0].storage_key).catch(() => undefined);
}

export async function purgeSource(ctx: Ctx, sourceId: string, workspaceId: string): Promise<void> {
  const rows = await ctx.db.query<{ storage_key: string | null }>(
    `DELETE FROM sources WHERE id = $1 AND workspace_id = $2 RETURNING storage_key`,
    [sourceId, workspaceId],
  );
  if (!rows[0]) throw new HttpError(404, "not_found", "Source not found");
  if (rows[0].storage_key) await ctx.storage.delete(rows[0].storage_key).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { JobRow, SourceRow };
