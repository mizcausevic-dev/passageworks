import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerUser } from "./auth.ts";
import type { Ctx } from "./ctx.ts";
import { createStoredSource, processNext } from "./ingest.ts";
import { isUniqueViolation } from "./util.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/northglass");

export async function seedDemo(ctx: Ctx): Promise<void> {
  const email = process.env.DEMO_EMAIL || "archivist@northglass.example";
  const password = process.env.DEMO_PASSWORD || "";
  if (password.length < 10) throw new Error("DEMO_PASSWORD must be at least 10 characters when SEED_DEMO is true");
  let userId: string;
  try {
    const created = await registerUser(ctx, { email, name: "Northglass Archivist", password });
    userId = created.user.id;
  } catch (error) {
    if (!isUniqueViolation(error) && !(error instanceof Error && "code" in error)) {
      const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
      if (!existing[0]) throw error;
      userId = existing[0].id;
    } else {
      const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
      if (!existing[0]) throw error;
      userId = existing[0].id;
    }
  }
  const already = await ctx.db.query(`SELECT p.id FROM projects p JOIN memberships m ON m.workspace_id = p.workspace_id
    WHERE m.user_id = $1 AND p.name = 'Northglass Basin' LIMIT 1`, [userId]);
  if (already[0]) return;
  const workspace = await ctx.db.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('Northglass') RETURNING id`,
  );
  const workspaceId = workspace[0]?.id;
  if (!workspaceId) return;
  await ctx.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [workspaceId, userId]);
  const project = await ctx.db.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, name, description, created_by)
     VALUES ($1, 'Northglass Basin', 'Fictional field notes used as a local demo. Not a real archive.', $2)
     RETURNING id`,
    [workspaceId, userId],
  );
  const projectId = project[0]?.id;
  if (!projectId) return;
  const log = new Uint8Array(await readFile(join(root, "field-log-014.txt")));
  const methods = new Uint8Array(await readFile(join(root, "methods-note.pdf")));
  const scan = new Uint8Array(await readFile(join(root, "plate-7.pdf")));
  await createStoredSource(ctx, {
    workspaceId,
    projectId,
    userId,
    kind: "note",
    title: "Field log 014",
    filename: "field-log-014.txt",
    declaredMime: "text/plain",
    bytes: log,
  });
  await createStoredSource(ctx, {
    workspaceId,
    projectId,
    userId,
    kind: "file",
    title: "Dye-trace method note",
    filename: "methods-note.pdf",
    declaredMime: "application/pdf",
    bytes: methods,
  });
  await createStoredSource(ctx, {
    workspaceId,
    projectId,
    userId,
    kind: "file",
    title: "Plate 7",
    filename: "plate-7.pdf",
    declaredMime: "application/pdf",
    bytes: scan,
  });
  for (let i = 0; i < 10; i += 1) {
    const worked = await processNext(ctx);
    if (!worked) break;
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  const { createRuntime } = await import("./runtime.ts");
  const ctx = await createRuntime();
  await seedDemo(ctx);
  console.log(JSON.stringify({ event: "seed_complete" }));
}
