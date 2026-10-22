import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  AI_DISCLOSURE,
  COLLABORATION,
  LIMITS,
  SEMANTIC_RETRIEVAL,
  STATIC_CAPABILITIES,
  permissionMatrix,
} from "../../../packages/domain/src/index.ts";
import { requireProject, requireUser, requireWorkspace, ownerCount } from "./access.ts";
import { createAnnotation, deleteAnnotation, listAnnotations } from "./annotations.ts";
import { loginUser, logoutToken, rateLimit, registerUser, userFromToken } from "./auth.ts";
import type { Ctx, SessionUser } from "./ctx.ts";
import {
  addComment,
  createDocument,
  createShare,
  deleteComment,
  generateBrief,
  getDocument,
  getRevision,
  listComments,
  listDocuments,
  listGenerations,
  listRevisions,
  listShares,
  presentDocument,
  readSharedBrief,
  revokeShare,
  updateDocument,
} from "./documents.ts";
import { HttpError } from "./errors.ts";
import {
  cancelJob,
  createStoredSource,
  createUrlSource,
  listJobs,
  listSources,
  loadSource,
  purgeSource,
  reprocessSource,
  retryJob,
  softDeleteSource,
} from "./ingest.ts";
import { searchProject } from "./search.ts";
import { cleanTitle, iso, safeFilename } from "./util.ts";

const registerSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax),
});
const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(LIMITS.passwordMax),
});
const nameSchema = z.object({ name: z.string().trim().min(1).max(LIMITS.maxNameChars) });
const projectSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.maxNameChars),
  description: z.string().trim().max(2_000).optional(),
});
const noteSchema = z.object({
  title: z.string().trim().max(LIMITS.maxTitleChars).optional(),
  text: z.string().min(1).max(LIMITS.maxNoteChars),
});
const urlSchema = z.object({
  url: z.string().trim().min(1).max(LIMITS.maxUrlChars),
  title: z.string().trim().max(LIMITS.maxTitleChars).optional(),
});
const memberSchema = z.object({
  email: z.string().trim().email().max(200),
  role: z.enum(["owner", "editor", "commenter", "viewer"]),
});
const roleSchema = z.object({ role: z.enum(["owner", "editor", "commenter", "viewer"]) });
const annotationSchema = z.object({
  passageId: z.string().regex(/^psg_[a-f0-9]{16}$/),
  quote: z.string().min(1).max(LIMITS.maxQuoteChars),
  note: z.string().max(LIMITS.maxAnnotationChars).default(""),
  charStart: z.number().int().nonnegative().optional(),
  charEnd: z.number().int().nonnegative().optional(),
  pageNumber: z.number().int().positive().nullable().optional(),
});
const docSchema = z.object({
  kind: z.enum(["note", "brief"]),
  title: z.string().trim().min(1).max(LIMITS.maxTitleChars),
  bodyHtml: z.string().max(LIMITS.maxNoteChars).optional(),
});
const saveSchema = z.object({
  baseRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(LIMITS.maxTitleChars),
  bodyHtml: z.string().max(LIMITS.maxNoteChars),
});
const commentSchema = z.object({ body: z.string().trim().min(1).max(4_000) });
const generateSchema = z.object({
  instruction: z.string().trim().min(1).max(LIMITS.maxInstructionChars),
  passageIds: z.array(z.string().regex(/^psg_[a-f0-9]{16}$/)).max(20).optional(),
  baseRevision: z.number().int().positive().optional(),
  apply: z.boolean().optional(),
});
const shareSchema = z.object({
  days: z.number().int().min(1).max(LIMITS.maxShareDays).default(LIMITS.defaultShareDays),
  exposeCitedPassages: z.boolean().default(false),
});
const collectionSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.maxNameChars),
  description: z.string().trim().max(2_000).optional(),
});

export function createApp(ctx: Ctx, options: { webDist?: string | null } = {}) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status as 400,
      );
    }
    console.log(JSON.stringify({ event: "unhandled", name: error instanceof Error ? error.name : "error" }));
    return c.json({ error: "internal", message: "The server could not complete that request." }, 500);
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") assertOrigin(c);
    await next();
  });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      search: "lexical",
      semantic: SEMANTIC_RETRIEVAL.status,
      ai: ctx.ai ? "configured" : "unavailable",
      collaboration: COLLABORATION.mode,
      realtime: COLLABORATION.realtime,
      ocr: "unavailable",
      storage: "private_local",
    }),
  );

  app.get("/api/capabilities", (c) =>
    c.json({
      capabilities: STATIC_CAPABILITIES,
      permissions: permissionMatrix(),
      collaboration: COLLABORATION,
      semantic: SEMANTIC_RETRIEVAL,
      runtime: {
        ai: ctx.ai ? "configured" : "unavailable",
        semantic: "unavailable",
        search: "lexical",
        collaboration: "optimistic_concurrency",
        realtime: "unavailable",
        ocr: "unavailable",
        storage: "private_local",
      },
      limits: LIMITS,
      disclosure: AI_DISCLOSURE,
      deletion: {
        softDelete:
          "Hides the source from the library and search, removes the private file bytes, keeps extracted versions, and marks annotations needs_review with reason source_deleted. Brief citations keep their stored passage snapshots.",
        purge:
          "Owner only. Deletes the source row, versions, passages, and annotations. Citation snapshots remain on briefs with the source link cleared.",
      },
    }),
  );

  app.get("/api/privacy", (c) =>
    c.json({
      product: "Passageworks",
      accounts: "Email, display name, and a password hash are stored for people who register.",
      sources: "Uploaded files, fetched pages, notes, and extracted text stay in this deployment's database and private storage.",
      sharing: "Projects are private to workspace members. A share link is a separate capability and does not publish the library.",
      ai: AI_DISCLOSURE,
      analytics: "This build does not send analytics to a third party.",
    }),
  );

  app.post("/api/auth/register", async (c) => {
    const input = parse(registerSchema, await readJson(c));
    rateLimit(ctx, `register:${input.email.toLowerCase()}`, 10, 60 * 60 * 1000);
    const { user, token } = await registerUser(ctx, input);
    setSession(c, token);
    return c.json({ user }, 201);
  });

  app.post("/api/auth/login", async (c) => {
    const input = parse(loginSchema, await readJson(c));
    const { user, token } = await loginUser(ctx, input);
    setSession(c, token);
    return c.json({ user });
  });

  app.post("/api/auth/logout", async (c) => {
    await logoutToken(ctx, readToken(c));
    deleteCookie(c, "pw_session", { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", async (c) => {
    const user = await requireUser(await current(c));
    return c.json({ user });
  });

  app.get("/api/shared/:token", async (c) => c.json(await readSharedBrief(ctx, c.req.param("token"))));

  app.post("/api/workspaces", async (c) => {
    const user = await requireUser(await current(c));
    const input = parse(nameSchema, await readJson(c));
    const workspace = await ctx.db.tx(async (db) => {
      const rows = await db.query<{ id: string; name: string }>(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name`,
        [input.name],
      );
      const row = rows[0];
      if (!row) throw new HttpError(500, "internal", "Could not create the workspace");
      await db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [row.id, user.id]);
      return row;
    });
    return c.json({ workspace }, 201);
  });

  app.get("/api/workspaces", async (c) => {
    const user = await requireUser(await current(c));
    const workspaces = await ctx.db.query(
      `SELECT w.id, w.name, m.role FROM workspaces w
       JOIN memberships m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at`,
      [user.id],
    );
    return c.json({ workspaces });
  });

  app.get("/api/workspaces/:id/members", async (c) => {
    const user = await requireUser(await current(c));
    await requireWorkspace(ctx, user.id, c.req.param("id"), "view");
    const members = await ctx.db.query(
      `SELECT u.id, u.email, u.name, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY m.created_at`,
      [c.req.param("id")],
    );
    return c.json({ members });
  });

  app.post("/api/workspaces/:id/members", async (c) => {
    const user = await requireUser(await current(c));
    const workspaceId = c.req.param("id");
    await requireWorkspace(ctx, user.id, workspaceId, "members.manage");
    const input = parse(memberSchema, await readJson(c));
    const found = await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [input.email.toLowerCase()]);
    const member = found[0];
    if (!member) throw new HttpError(404, "user_not_found", "That email does not have an account");
    await ctx.db.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, member.id, input.role],
    );
    return c.json({ ok: true }, 201);
  });

  app.patch("/api/workspaces/:id/members/:userId", async (c) => {
    const user = await requireUser(await current(c));
    const workspaceId = c.req.param("id");
    await requireWorkspace(ctx, user.id, workspaceId, "members.manage");
    const input = parse(roleSchema, await readJson(c));
    await guardLastOwner(ctx, workspaceId, c.req.param("userId"), input.role);
    const rows = await ctx.db.query(
      `UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id`,
      [workspaceId, c.req.param("userId"), input.role],
    );
    if (!rows[0]) throw new HttpError(404, "not_found", "Member not found");
    return c.json({ ok: true });
  });

  app.delete("/api/workspaces/:id/members/:userId", async (c) => {
    const user = await requireUser(await current(c));
    const workspaceId = c.req.param("id");
    await requireWorkspace(ctx, user.id, workspaceId, "members.manage");
    await guardLastOwner(ctx, workspaceId, c.req.param("userId"), null);
    const rows = await ctx.db.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id`, [
      workspaceId,
      c.req.param("userId"),
    ]);
    if (!rows[0]) throw new HttpError(404, "not_found", "Member not found");
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:id/projects", async (c) => {
    const user = await requireUser(await current(c));
    const workspaceId = c.req.param("id");
    await requireWorkspace(ctx, user.id, workspaceId, "project.create");
    const input = parse(projectSchema, await readJson(c));
    const rows = await ctx.db.query(
      `INSERT INTO projects (workspace_id, name, description, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, workspace_id, name, description`,
      [workspaceId, input.name, input.description ?? "", user.id],
    );
    return c.json({ project: rows[0] }, 201);
  });

  app.get("/api/workspaces/:id/projects", async (c) => {
    const user = await requireUser(await current(c));
    await requireWorkspace(ctx, user.id, c.req.param("id"), "view");
    const projects = await ctx.db.query(
      `SELECT id, name, description, updated_at FROM projects
       WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [c.req.param("id")],
    );
    return c.json({ projects });
  });

  app.get("/api/projects/:id", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "view");
    return c.json({ project });
  });

  app.get("/api/projects/:id/sources", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "view");
    const sources = await listSources(ctx, project.id);
    return c.json({ sources: sources.map(presentSource) });
  });

  app.post("/api/projects/:id/sources/note", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "source.add");
    const input = parse(noteSchema, await readJson(c));
    const text = input.text.replace(/\r\n/g, "\n");
    const queued = await createStoredSource(ctx, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      userId: user.id,
      kind: "note",
      title: cleanTitle(input.title, text.split("\n")[0] ?? "Note"),
      filename: null,
      declaredMime: "text/plain",
      bytes: new TextEncoder().encode(text),
    });
    return c.json(queued, 202);
  });

  app.post("/api/projects/:id/sources/url", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "source.add");
    rateLimit(ctx, `url:${user.id}`, 30, 60 * 60 * 1000);
    const input = parse(urlSchema, await readJson(c));
    const queued = await createUrlSource(ctx, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      userId: user.id,
      url: input.url,
      title: input.title,
    });
    return c.json(queued, 202);
  });

  app.post("/api/projects/:id/sources/file", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "source.add");
    const raw = await readLimited(c.req.raw, LIMITS.maxFileBytes + 16_384);
    const replay = new Request(c.req.url, {
      method: "POST",
      headers: { "content-type": c.req.header("content-type") ?? "" },
      body: Buffer.from(raw),
    });
    const form = await replay.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "file_required", "Choose a file");
    const titleValue = form.get("title");
    const title = typeof titleValue === "string" ? titleValue : file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const queued = await createStoredSource(ctx, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      userId: user.id,
      kind: "file",
      title: cleanTitle(title, "Untitled file"),
      filename: file.name,
      declaredMime: file.type || null,
      bytes,
    });
    return c.json(queued, 202);
  });

  app.get("/api/sources/:id", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "view");
    const version = await currentVersion(ctx, source.id, source.current_version_id);
    const jobs = await ctx.db.query(
      `SELECT id, status, attempts, max_attempts, retryable, error_code, last_error, cancel_requested, created_at, finished_at
       FROM jobs WHERE source_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [source.id],
    );
    return c.json({ source: presentSource(source), version, jobs });
  });

  app.get("/api/sources/:id/versions/:versionId", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "view");
    const version = await currentVersion(ctx, source.id, c.req.param("versionId"));
    if (!version) throw new HttpError(404, "not_found", "Version not found");
    return c.json({ version });
  });

  app.get("/api/sources/:id/file", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "source.file");
    if (!source.storage_key) throw new HttpError(404, "file_removed", "The original file is not available");
    let bytes: Uint8Array;
    try {
      bytes = await ctx.storage.get(source.storage_key);
    } catch {
      throw new HttpError(404, "file_removed", "The original file is not available");
    }
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${safeFilename(source.original_filename ?? source.title)}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  app.delete("/api/sources/:id", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "source.delete");
    await softDeleteSource(ctx, source.id, source.workspace_id);
    return c.json({ ok: true, effect: "soft_delete" });
  });

  app.post("/api/sources/:id/purge", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "source.purge", true);
    await purgeSource(ctx, source.id, source.workspace_id);
    return c.json({ ok: true, effect: "purge" });
  });

  app.post("/api/sources/:id/reprocess", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "job.manage");
    return c.json(await reprocessSource(ctx, source.id, source.workspace_id), 202);
  });

  app.get("/api/projects/:id/jobs", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "view");
    return c.json({ jobs: await listJobs(ctx, project.id) });
  });

  app.post("/api/jobs/:id/cancel", async (c) => {
    const user = await requireUser(await current(c));
    const job = await jobForMember(c, user, "job.manage");
    return c.json(await cancelJob(ctx, job.id, job.workspace_id));
  });

  app.post("/api/jobs/:id/retry", async (c) => {
    const user = await requireUser(await current(c));
    const job = await jobForMember(c, user, "job.manage");
    return c.json(await retryJob(ctx, job.id, job.workspace_id));
  });

  app.get("/api/sources/:id/annotations", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "view");
    return c.json({ annotations: await listAnnotations(ctx, source.id) });
  });

  app.post("/api/sources/:id/annotations", async (c) => {
    const user = await requireUser(await current(c));
    const source = await sourceForMember(c, user, "annotate");
    const input = parse(annotationSchema, await readJson(c));
    const annotation = await createAnnotation(ctx, user, source.id, {
      passageId: input.passageId,
      quote: input.quote,
      note: input.note ?? "",
      charStart: input.charStart,
      charEnd: input.charEnd,
      pageNumber: input.pageNumber ?? undefined,
    });
    return c.json({ annotation }, 201);
  });

  app.delete("/api/annotations/:id", async (c) => {
    const user = await requireUser(await current(c));
    const rows = await ctx.db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM annotations WHERE id = $1 AND deleted_at IS NULL`,
      [c.req.param("id")],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "not_found", "Annotation not found");
    const role = await requireWorkspace(ctx, user.id, row.workspace_id, "view");
    const moderate = role === "owner" || role === "editor";
    if (!moderate && role === "viewer") throw new HttpError(403, "forbidden", "Your role does not allow that");
    await deleteAnnotation(ctx, user, c.req.param("id"), moderate);
    return c.json({ ok: true });
  });

  app.get("/api/projects/:id/collections", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "view");
    const collections = await ctx.db.query(
      `SELECT id, name, description FROM collections WHERE project_id = $1 ORDER BY created_at`,
      [project.id],
    );
    return c.json({ collections });
  });

  app.post("/api/projects/:id/collections", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "source.add");
    const input = parse(collectionSchema, await readJson(c));
    const rows = await ctx.db.query(
      `INSERT INTO collections (workspace_id, project_id, name, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, description`,
      [project.workspace_id, project.id, input.name, input.description ?? "", user.id],
    );
    return c.json({ collection: rows[0] }, 201);
  });

  app.post("/api/collections/:id/sources", async (c) => {
    const user = await requireUser(await current(c));
    const input = parse(z.object({ sourceId: z.string().uuid() }), await readJson(c));
    const collections = await ctx.db.query<{ id: string; project_id: string; workspace_id: string }>(
      `SELECT id, project_id, workspace_id FROM collections WHERE id = $1`,
      [c.req.param("id")],
    );
    const collection = collections[0];
    if (!collection) throw new HttpError(404, "not_found", "Collection not found");
    await requireProject(ctx, user.id, collection.project_id, "source.add");
    const source = await loadSource(ctx, input.sourceId, collection.workspace_id);
    if (source.project_id !== collection.project_id) throw new HttpError(404, "not_found", "Source not found");
    await ctx.db.query(
      `INSERT INTO collection_items (collection_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [collection.id, source.id],
    );
    return c.json({ ok: true }, 201);
  });

  app.get("/api/projects/:id/search", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "view");
    const kind = c.req.query("kind") ?? null;
    const collectionId = c.req.query("collectionId") ?? null;
    if (collectionId && !z.string().uuid().safeParse(collectionId).success) {
      throw new HttpError(400, "bad_filter", "Collection id is not valid");
    }
    const result = await searchProject(ctx, {
      projectId: project.id,
      workspaceId: project.workspace_id,
      q: c.req.query("q") ?? "",
      kind,
      collectionId,
    });
    return c.json(result);
  });

  app.get("/api/projects/:id/documents", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "view");
    const kind = c.req.query("kind");
    const documents = await listDocuments(ctx, project.id, kind === "note" || kind === "brief" ? kind : null);
    return c.json({ documents: documents.map(presentDocument) });
  });

  app.post("/api/projects/:id/documents", async (c) => {
    const user = await requireUser(await current(c));
    const project = await requireProject(ctx, user.id, c.req.param("id"), "document.edit");
    const input = parse(docSchema, await readJson(c));
    const doc = await createDocument(ctx, user, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      kind: input.kind,
      title: input.title,
      bodyHtml: input.bodyHtml,
    });
    return c.json({ document: presentDocument(doc) }, 201);
  });

  app.get("/api/documents/:id", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "view");
    return c.json({ document: presentDocument(doc) });
  });

  app.patch("/api/documents/:id", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "document.edit");
    const input = parse(saveSchema, await readJson(c));
    const saved = await updateDocument(ctx, user, doc.id, input);
    return c.json({ document: presentDocument(saved) });
  });

  app.get("/api/documents/:id/revisions", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "view");
    const revisions = await listRevisions(ctx, doc.id);
    return c.json({
      revisions: revisions.map((row) => ({
        revision: row.revision,
        title: row.title,
        createdAt: iso(row.created_at),
        authorName: row.author_name,
      })),
    });
  });

  app.get("/api/documents/:id/revisions/:revision", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "view");
    const revision = Number(c.req.param("revision"));
    const row = await getRevision(ctx, doc.id, revision);
    if (!row) throw new HttpError(404, "not_found", "Revision not found");
    return c.json({
      revision: row.revision,
      title: row.title,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      createdAt: iso(row.created_at),
      authorName: row.author_name,
    });
  });

  app.post("/api/documents/:id/restore", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "document.edit");
    const input = parse(
      z.object({ revision: z.number().int().positive(), baseRevision: z.number().int().positive() }),
      await readJson(c),
    );
    const historical = await getRevision(ctx, doc.id, input.revision);
    if (!historical) throw new HttpError(404, "not_found", "Revision not found");
    const saved = await updateDocument(ctx, user, doc.id, {
      baseRevision: input.baseRevision,
      title: historical.title,
      bodyHtml: historical.body_html,
    });
    return c.json({ document: presentDocument(saved) });
  });

  app.get("/api/documents/:id/comments", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "view");
    const comments = await listComments(ctx, doc.id);
    return c.json({
      comments: comments.map((row) => ({
        id: row.id,
        body: row.body,
        authorId: row.author_id,
        authorName: row.author_name,
        createdAt: iso(row.created_at),
      })),
    });
  });

  app.post("/api/documents/:id/comments", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "comment");
    const input = parse(commentSchema, await readJson(c));
    const comment = await addComment(ctx, user, doc.id, input.body);
    return c.json({ comment }, 201);
  });

  app.delete("/api/comments/:id", async (c) => {
    const user = await requireUser(await current(c));
    const rows = await ctx.db.query<{ workspace_id: string }>(
      `SELECT d.workspace_id FROM comments c JOIN documents d ON d.id = c.document_id
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [c.req.param("id")],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "not_found", "Comment not found");
    const role = await requireWorkspace(ctx, user.id, row.workspace_id, "view");
    await deleteComment(ctx, user.id, c.req.param("id"), role === "owner" || role === "editor");
    return c.json({ ok: true });
  });

  app.post("/api/documents/:id/generate", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "document.edit");
    const input = parse(generateSchema, await readJson(c));
    const result = await generateBrief(ctx, user, doc.id, input);
    const status = result.conflict ? 409 : 200;
    return c.json(result, status as 200);
  });

  app.get("/api/documents/:id/generations", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "view");
    return c.json({ generations: await listGenerations(ctx, doc.id) });
  });

  app.post("/api/documents/:id/shares", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "share.manage");
    const input = parse(shareSchema, await readJson(c));
    const share = await createShare(ctx, user, doc.id, {
      days: input.days ?? LIMITS.defaultShareDays,
      exposeCitedPassages: input.exposeCitedPassages ?? false,
    });
    return c.json({ share }, 201);
  });

  app.get("/api/documents/:id/shares", async (c) => {
    const user = await requireUser(await current(c));
    const doc = await documentFor(c, user, "share.manage");
    return c.json({ shares: await listShares(ctx, doc.id) });
  });

  app.post("/api/shares/:id/revoke", async (c) => {
    const user = await requireUser(await current(c));
    const rows = await ctx.db.query<{ workspace_id: string }>(`SELECT workspace_id FROM share_links WHERE id = $1`, [
      c.req.param("id"),
    ]);
    const row = rows[0];
    if (!row) throw new HttpError(404, "not_found", "Share link not found");
    await requireWorkspace(ctx, user.id, row.workspace_id, "share.manage");
    await revokeShare(ctx, c.req.param("id"), row.workspace_id);
    return c.json({ ok: true });
  });

  app.get("/api/passages/:passageId", async (c) => {
    const user = await requireUser(await current(c));
    const rows = await ctx.db.query<{
      passage_id: string;
      text: string;
      page_number: number | null;
      source_id: string;
      source_version_id: string;
      title: string;
      workspace_id: string;
      deleted_at: Date | string | null;
    }>(
      `SELECT c.passage_id, c.text, c.page_number, c.source_id, c.source_version_id, s.title, s.workspace_id, s.deleted_at
       FROM chunks c JOIN sources s ON s.id = c.source_id
       WHERE c.passage_id = $1`,
      [c.req.param("passageId")],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "not_found", "Passage not found");
    await requireWorkspace(ctx, user.id, row.workspace_id, "view");
    return c.json({
      passageId: row.passage_id,
      text: row.text,
      pageNumber: row.page_number,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      sourceTitle: row.title,
      sourceDeleted: row.deleted_at != null,
      pageNote: row.page_number == null ? "Extraction did not provide a single page for this passage." : null,
    });
  });

  if (options.webDist) serveWeb(app, options.webDist);
  app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));
  return app;

  async function current(c: Context): Promise<SessionUser | null> {
    return userFromToken(ctx, readToken(c));
  }

  function setSession(c: Context, token: string) {
    setCookie(c, "pw_session", token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: ctx.cookieSecure,
      maxAge: 14 * 24 * 60 * 60,
    });
  }

  async function sourceForMember(
    c: Context,
    user: SessionUser,
    action: Parameters<typeof requireProject>[3],
    includeDeleted = false,
  ) {
    const rows = await ctx.db.query<{ project_id: string; deleted_at: string | null }>(
      `SELECT project_id, deleted_at FROM sources WHERE id = $1`,
      [c.req.param("id")],
    );
    const stub = rows[0];
    if (!stub || (stub.deleted_at && !includeDeleted)) throw new HttpError(404, "not_found", "Source not found");
    await requireProject(ctx, user.id, stub.project_id, action);
    if (includeDeleted) {
      const all = await ctx.db.query<Awaited<ReturnType<typeof loadSource>>>(
        `SELECT * FROM sources WHERE id = $1`,
        [c.req.param("id")],
      );
      const source = all[0];
      if (!source) throw new HttpError(404, "not_found", "Source not found");
      return source;
    }
    const project = await requireProject(ctx, user.id, stub.project_id, "view");
    const sourceId = c.req.param("id");
    if (!sourceId) throw new HttpError(404, "not_found", "Source not found");
    return loadSource(ctx, sourceId, project.workspace_id);
  }

  async function jobForMember(c: Context, user: SessionUser, action: Parameters<typeof requireProject>[3]) {
    const rows = await ctx.db.query<{ id: string; project_id: string; workspace_id: string }>(
      `SELECT id, project_id, workspace_id FROM jobs WHERE id = $1`,
      [c.req.param("id")],
    );
    const job = rows[0];
    if (!job) throw new HttpError(404, "not_found", "Job not found");
    await requireProject(ctx, user.id, job.project_id, action);
    return job;
  }

  async function documentFor(c: Context, user: SessionUser, action: Parameters<typeof requireProject>[3]) {
    const documentId = c.req.param("id");
    if (!documentId) throw new HttpError(404, "not_found", "Document not found");
    const doc = await getDocument(ctx, documentId);
    if (!doc) throw new HttpError(404, "not_found", "Document not found");
    await requireProject(ctx, user.id, doc.project_id, action);
    return doc;
  }
}

function readToken(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return getCookie(c as never, "pw_session");
}

function assertOrigin(c: { req: { header: (name: string) => string | undefined } }) {
  const origin = c.req.header("origin");
  if (!origin) return;
  const host = c.req.header("host");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "bad_origin", "Origin was rejected");
  }
  if (!host || originHost !== host) throw new HttpError(403, "bad_origin", "Origin was rejected");
}

async function readLimited(request: Request, max: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > max) throw new HttpError(413, "too_large", "The file exceeds the 15 MB limit");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "empty_source", "The upload was empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "The file exceeds the 15 MB limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "The body is not JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "invalid_body", "The request body is not valid", {
      issues: result.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

async function guardLastOwner(ctx: Ctx, workspaceId: string, userId: string, nextRole: string | null) {
  const rows = await ctx.db.query<{ role: string }>(
    `SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  if (rows[0]?.role !== "owner") return;
  if (nextRole === "owner") return;
  if ((await ownerCount(ctx, workspaceId)) <= 1) {
    throw new HttpError(409, "last_owner", "The workspace needs one owner");
  }
}

function presentSource(source: {
  id: string;
  project_id: string;
  workspace_id: string;
  kind: string;
  title: string;
  original_filename: string | null;
  declared_mime: string | null;
  detected_mime: string | null;
  byte_size: number | null;
  origin_url: string | null;
  outcome: string | null;
  outcome_detail: string | null;
  current_version_id: string | null;
  raw_sha256: string | null;
  created_at: Date | string;
  ingested_at: Date | string | null;
  metadata: unknown;
}) {
  return {
    id: source.id,
    projectId: source.project_id,
    workspaceId: source.workspace_id,
    kind: source.kind,
    title: source.title,
    originalFilename: source.original_filename,
    declaredMime: source.declared_mime,
    detectedMime: source.detected_mime,
    byteSize: source.byte_size,
    originUrl: source.origin_url,
    outcome: source.outcome,
    outcomeDetail: source.outcome_detail,
    currentVersionId: source.current_version_id,
    rawSha256: source.raw_sha256,
    createdAt: iso(source.created_at),
    ingestedAt: iso(source.ingested_at),
    metadata: source.metadata ?? {},
  };
}

async function currentVersion(ctx: Ctx, sourceId: string, versionId: string | null) {
  if (!versionId) return null;
  const versions = await ctx.db.query<{
    id: string;
    version_number: number;
    extraction_method: string;
    outcome: string;
    content_text: string;
    content_html: string | null;
    page_count: number | null;
    ocr_required: boolean;
    password_protected: boolean;
    detail: string | null;
    extractor: string;
    content_sha256: string;
    created_at: Date | string;
  }>(
    `SELECT id, version_number, extraction_method, outcome, content_text, content_html, page_count, ocr_required,
            password_protected, detail, extractor, content_sha256, created_at
     FROM source_versions WHERE id = $1 AND source_id = $2`,
    [versionId, sourceId],
  );
  const version = versions[0];
  if (!version) return null;
  const chunks = await ctx.db.query(
    `SELECT passage_id, ordinal, text, char_start, char_end, page_number
     FROM chunks WHERE source_version_id = $1 ORDER BY ordinal`,
    [version.id],
  );
  const pages = await ctx.db.query(
    `SELECT page_number, char_start, char_end, text_chars FROM pages WHERE source_version_id = $1 ORDER BY page_number`,
    [version.id],
  );
  return {
    id: version.id,
    versionNumber: version.version_number,
    extractionMethod: version.extraction_method,
    outcome: version.outcome,
    contentText: version.content_text,
    contentHtml: version.content_html,
    pageCount: version.page_count,
    ocrRequired: version.ocr_required,
    passwordProtected: version.password_protected,
    detail: version.detail,
    extractor: version.extractor,
    contentSha256: version.content_sha256,
    createdAt: iso(version.created_at),
    chunks: chunks.map((chunk) => ({
      passageId: chunk.passage_id,
      ordinal: chunk.ordinal,
      text: chunk.text,
      charStart: chunk.char_start,
      charEnd: chunk.char_end,
      pageNumber: chunk.page_number,
    })),
    pages: pages.map((page) => ({
      pageNumber: page.page_number,
      charStart: page.char_start,
      charEnd: page.char_end,
      textChars: page.text_chars,
    })),
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveWeb(app: Hono, webDist: string) {
  const root = resolve(webDist);
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    const url = new URL(c.req.url);
    const requested = decodeURIComponent(url.pathname);
    const candidate = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
    if (candidate.includes("\0")) return c.notFound();
    const full = resolve(root, candidate);
    if (!full.startsWith(root + sep) && full !== root) return c.notFound();
    const file = await readableFile(full);
    const ext = extname(full);
    if (file && TYPES[ext]) {
      c.header("Content-Type", TYPES[ext]);
      if (ext === ".html") c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
      return c.body(file);
    }
    if (ext) return c.notFound();
    const index = await readableFile(join(root, "index.html"));
    if (!index) return c.notFound();
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    return c.body(index);
  });
}

async function readableFile(path: string): Promise<ReadableStream | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return Readable.toWeb(createReadStream(path)) as ReadableStream;
  } catch {
    return null;
  }
}
