import sanitizeHtml from "sanitize-html";
import { LIMITS, SEMANTIC_RETRIEVAL } from "../../../packages/domain/src/index.ts";
import type { Db } from "./db.ts";
import type { Ctx } from "./ctx.ts";
import { HttpError } from "./errors.ts";

export type SearchHit = {
  resultType: string;
  passageId: string | null;
  sourceId: string | null;
  documentId: string | null;
  title: string;
  pageNumber: number | null;
  snippet: string;
  rank: number;
};

export type PassageRow = {
  passage_id: string;
  text: string;
  page_number: number | null;
  source_id: string;
  source_version_id: string;
  title: string;
  source_deleted: boolean;
};

const INDEX_DELAY =
  "Search uses the current extracted text, source titles, annotations, working notes, and briefs. A source is missing from passage search until its job completes with extracted text. OCR-required PDFs, password-protected PDFs, and failed ingestions have no passage text. Only the current version is indexed. Older versions stay stored on the source. Semantic ranking is not available.";

export async function searchProject(
  ctx: Ctx,
  input: { projectId: string; workspaceId: string; q: string; kind: string | null; collectionId: string | null },
): Promise<{ query: string; results: SearchHit[]; indexDelay: string; semantic: typeof SEMANTIC_RETRIEVAL }> {
  const q = input.q.trim();
  if (!q) throw new HttpError(400, "empty_query", "Enter a search query");
  if (q.length > 300) throw new HttpError(400, "query_too_long", "That query is too long");
  const kind = input.kind;
  const sourceKinds = new Set(["file", "url", "note"]);
  const docKinds = new Set(["working_note", "brief"]);
  if (kind && !sourceKinds.has(kind) && !docKinds.has(kind)) {
    throw new HttpError(400, "bad_filter", "Unknown search filter");
  }
  const includeSources = !kind || sourceKinds.has(kind);
  const includeDocs = !kind || docKinds.has(kind);
  const sourceKind = kind && sourceKinds.has(kind) ? kind : null;
  const docKind = kind === "working_note" ? "note" : kind === "brief" ? "brief" : null;
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await ctx.db.query(
      `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query)
       SELECT * FROM (
         SELECT 'passage'::text AS result_type, c.passage_id, c.source_id, NULL::uuid AS document_id, s.title,
                c.page_number, ts_rank(c.tsv, q.query) AS rank,
                ts_headline('english', replace(replace(replace(c.text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), q.query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=8') AS snippet
         FROM chunks c
         JOIN sources s ON s.id = c.source_id AND s.deleted_at IS NULL AND s.current_version_id = c.source_version_id
         JOIN q ON c.tsv @@ q.query
         WHERE s.project_id = $2 AND s.workspace_id = $3
           AND $8::boolean = true
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM collection_items ci WHERE ci.collection_id = $4 AND ci.source_id = s.id
           ))
           AND ($5::text IS NULL OR s.kind = $5)
         UNION ALL
         SELECT 'annotation'::text, a.passage_id, a.source_id, NULL::uuid, s.title, a.page_number,
                ts_rank(a.tsv, q.query),
                ts_headline('english', replace(replace(replace(a.quote || ' ' || a.note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), q.query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=8')
         FROM annotations a
         JOIN sources s ON s.id = a.source_id AND s.deleted_at IS NULL
         JOIN q ON a.tsv @@ q.query
         WHERE a.project_id = $2 AND a.workspace_id = $3 AND a.deleted_at IS NULL
           AND $8::boolean = true
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM collection_items ci WHERE ci.collection_id = $4 AND ci.source_id = s.id
           ))
           AND ($5::text IS NULL OR s.kind = $5)
         UNION ALL
         SELECT d.kind, NULL::text, NULL::uuid, d.id, d.title, NULL::int, ts_rank(d.tsv, q.query),
                ts_headline('english', replace(replace(replace(d.title || ' ' || d.body_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), q.query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=8')
         FROM documents d
         JOIN q ON d.tsv @@ q.query
         WHERE d.project_id = $2 AND d.workspace_id = $3 AND d.deleted_at IS NULL
           AND $9::boolean = true
           AND $4::uuid IS NULL
           AND ($6::text IS NULL OR d.kind = $6)
         UNION ALL
         SELECT 'source_title'::text, NULL::text, s.id, NULL::uuid, s.title, NULL::int, ts_rank(s.title_tsv, q.query),
                ts_headline('english', replace(replace(replace(s.title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), q.query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=4')
         FROM sources s
         JOIN q ON s.title_tsv @@ q.query
         WHERE s.project_id = $2 AND s.workspace_id = $3 AND s.deleted_at IS NULL
           AND $8::boolean = true
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM collection_items ci WHERE ci.collection_id = $4 AND ci.source_id = s.id
           ))
           AND ($5::text IS NULL OR s.kind = $5)
       ) hits
       ORDER BY rank DESC
       LIMIT $7`,
      [
        q,
        input.projectId,
        input.workspaceId,
        input.collectionId,
        sourceKind,
        docKind,
        LIMITS.searchLimit,
        includeSources,
        includeDocs,
      ],
    );
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "42601" || code === "22P02") throw new HttpError(400, "bad_query", "That search query could not be parsed");
    throw error;
  }
  return {
    query: q,
    indexDelay: INDEX_DELAY,
    semantic: SEMANTIC_RETRIEVAL,
    results: rows.map((row) => ({
      resultType: String(row.result_type),
      passageId: row.passage_id ? String(row.passage_id) : null,
      sourceId: row.source_id ? String(row.source_id) : null,
      documentId: row.document_id ? String(row.document_id) : null,
      title: String(row.title ?? ""),
      pageNumber: row.page_number == null ? null : Number(row.page_number),
      snippet: sanitizeSnippet(String(row.snippet ?? "")),
      rank: Number(row.rank ?? 0),
    })),
  };
}

function sanitizeSnippet(snippet: string): string {
  return sanitizeHtml(snippet, { allowedTags: ["mark"], allowedAttributes: {} });
}

export async function passagesByIds(db: Db, workspaceId: string, ids: string[]): Promise<PassageRow[]> {
  if (ids.length === 0) return [];
  return db.query<PassageRow>(
    `SELECT c.passage_id, c.text, c.page_number, c.source_id, c.source_version_id, s.title,
            (s.deleted_at IS NOT NULL) AS source_deleted
     FROM chunks c
     JOIN sources s ON s.id = c.source_id
     WHERE c.passage_id = ANY($1::text[]) AND s.workspace_id = $2`,
    [ids, workspaceId],
  );
}

export async function lexicalPassages(
  ctx: Ctx,
  input: { projectId: string; workspaceId: string; q: string; limit: number },
): Promise<PassageRow[]> {
  return ctx.db.query<PassageRow>(
    `SELECT c.passage_id, c.text, c.page_number, c.source_id, c.source_version_id, s.title,
            false AS source_deleted
     FROM chunks c
     JOIN sources s ON s.id = c.source_id AND s.deleted_at IS NULL AND s.current_version_id = c.source_version_id
     WHERE s.project_id = $1 AND s.workspace_id = $2
       AND c.tsv @@ websearch_to_tsquery('english', $3)
     ORDER BY ts_rank(c.tsv, websearch_to_tsquery('english', $3)) DESC
     LIMIT $4`,
    [input.projectId, input.workspaceId, input.q, input.limit],
  );
}
