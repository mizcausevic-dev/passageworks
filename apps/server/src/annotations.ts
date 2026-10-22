import type { Ctx, SessionUser } from "./ctx.ts";
import { HttpError } from "./errors.ts";
import { iso } from "./util.ts";

type ChunkRow = {
  id: string;
  source_id: string;
  source_version_id: string;
  workspace_id: string;
  project_id: string;
  passage_id: string;
  text: string;
  char_start: number;
  char_end: number;
  page_number: number | null;
  content_text: string;
};

export async function createAnnotation(
  ctx: Ctx,
  user: SessionUser,
  sourceId: string,
  input: { passageId: string; quote: string; note: string; charStart?: number; charEnd?: number; pageNumber?: number },
) {
  const rows = await ctx.db.query<ChunkRow>(
    `SELECT c.id, c.source_id, c.source_version_id, c.workspace_id, c.project_id, c.passage_id, c.text,
            c.char_start, c.char_end, c.page_number, sv.content_text
     FROM chunks c
     JOIN source_versions sv ON sv.id = c.source_version_id
     JOIN sources s ON s.id = c.source_id AND s.deleted_at IS NULL
     WHERE c.passage_id = $1 AND c.source_id = $2`,
    [input.passageId, sourceId],
  );
  const chunk = rows[0];
  if (!chunk) throw new HttpError(400, "unknown_citation", "That passage is not on this source");
  if (input.pageNumber != null && input.pageNumber !== chunk.page_number) {
    throw new HttpError(400, "page_unknown", "That page number was not produced by extraction");
  }
  let charStart: number | null = input.charStart ?? null;
  let charEnd: number | null = input.charEnd ?? null;
  if (charStart != null || charEnd != null) {
    if (charStart == null || charEnd == null || charStart < chunk.char_start || charEnd > chunk.char_end || charEnd < charStart) {
      throw new HttpError(400, "offset_mismatch", "Those offsets do not match the passage");
    }
    if (chunk.content_text.slice(charStart, charEnd) !== input.quote) {
      throw new HttpError(400, "offset_mismatch", "The quote does not match those offsets");
    }
  } else if (!chunk.text.includes(input.quote)) {
    throw new HttpError(400, "quote_not_in_passage", "The quote was not found in that passage");
  } else if (chunk.text.split(input.quote).length - 1 === 1) {
    const relative = chunk.text.indexOf(input.quote);
    charStart = chunk.char_start + relative;
    charEnd = charStart + input.quote.length;
  }
  const inserted = await ctx.db.query<{
    id: string;
    passage_id: string;
    quote: string;
    note: string;
    char_start: number | null;
    char_end: number | null;
    page_number: number | null;
    needs_review: boolean;
    review_reason: string | null;
    created_at: Date | string;
    author_id: string;
  }>(
    `INSERT INTO annotations (
       workspace_id, project_id, source_id, source_version_id, chunk_id, passage_id, quote, note,
       char_start, char_end, page_number, author_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, passage_id, quote, note, char_start, char_end, page_number, needs_review, review_reason, created_at, author_id`,
    [
      chunk.workspace_id,
      chunk.project_id,
      chunk.source_id,
      chunk.source_version_id,
      chunk.id,
      chunk.passage_id,
      input.quote,
      input.note,
      charStart,
      charEnd,
      chunk.page_number,
      user.id,
    ],
  );
  const row = inserted[0];
  if (!row) throw new HttpError(500, "internal", "Could not save the annotation");
  return presentAnnotation(row);
}

export async function listAnnotations(ctx: Ctx, sourceId: string) {
  const rows = await ctx.db.query<{
    id: string;
    passage_id: string;
    quote: string;
    note: string;
    char_start: number | null;
    char_end: number | null;
    page_number: number | null;
    needs_review: boolean;
    review_reason: string | null;
    created_at: Date | string;
    author_id: string;
    author_name: string | null;
  }>(
    `SELECT a.id, a.passage_id, a.quote, a.note, a.char_start, a.char_end, a.page_number, a.needs_review,
            a.review_reason, a.created_at, a.author_id, u.name AS author_name
     FROM annotations a
     LEFT JOIN users u ON u.id = a.author_id
     WHERE a.source_id = $1 AND a.deleted_at IS NULL
     ORDER BY a.created_at`,
    [sourceId],
  );
  return rows.map(presentAnnotation);
}

export async function deleteAnnotation(ctx: Ctx, user: SessionUser, annotationId: string, canModerate: boolean) {
  const rows = await ctx.db.query<{ author_id: string }>(
    `SELECT author_id FROM annotations WHERE id = $1 AND deleted_at IS NULL`,
    [annotationId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "not_found", "Annotation not found");
  if (!canModerate && row.author_id !== user.id) throw new HttpError(403, "forbidden", "You can delete your own annotations");
  await ctx.db.query(`UPDATE annotations SET deleted_at = now() WHERE id = $1`, [annotationId]);
}

function presentAnnotation(row: {
  id: string;
  passage_id: string;
  quote: string;
  note: string;
  char_start: number | null;
  char_end: number | null;
  page_number: number | null;
  needs_review: boolean;
  review_reason: string | null;
  created_at: Date | string;
  author_id: string;
  author_name?: string | null;
}) {
  return {
    id: row.id,
    passageId: row.passage_id,
    quote: row.quote,
    note: row.note,
    charStart: row.char_start,
    charEnd: row.char_end,
    pageNumber: row.page_number,
    needsReview: row.needs_review,
    reviewReason: row.review_reason,
    createdAt: iso(row.created_at),
    authorId: row.author_id,
    authorName: row.author_name ?? null,
  };
}
