import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import type { Ctx } from "../src/ctx.ts";
import { migrate, openPglite } from "../src/db.ts";
import { processNext } from "../src/ingest.ts";
import { MemoryStore } from "../src/storage.ts";

test("a queued fetch can be cancelled before the worker requests it", async () => {
  const calls: string[] = [];
  const db = await openPglite();
  await migrate(db);
  const ctx: Ctx = {
    db,
    storage: new MemoryStore(),
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response("<p>Should not be fetched.</p>", { headers: { "content-type": "text/html" } });
    },
    ai: null,
    workerId: "cancel-test",
    cookieSecure: false,
    limitsEnabled: false,
    backoffMs: () => 0,
  };
  const app = createApp(ctx);
  const registered = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cancel@northglass.example", name: "Cancel", password: "correct-horse-battery" }),
  });
  const cookie = (registered.headers.getSetCookie?.()[0] ?? "").split(";")[0] ?? "";
  const workspace = await app.request("/api/workspaces", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Cancel lab" }),
  });
  const workspaceBody = await workspace.json() as { workspace: { id: string } };
  const project = await app.request(`/api/workspaces/${workspaceBody.workspace.id}/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Hold", description: "" }),
  });
  const projectBody = await project.json() as { project: { id: string } };
  const queued = await app.request(`/api/projects/${projectBody.project.id}/sources/url`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://archive.northglass.example/hold" }),
  });
  const queuedBody = await queued.json() as { jobId: string };
  assert.equal(queued.status, 202);
  const cancelled = await app.request(`/api/jobs/${queuedBody.jobId}/cancel`, { method: "POST", headers: { cookie } });
  assert.equal(cancelled.status, 200);
  assert.equal(await processNext(ctx), false);
  assert.deepEqual(calls, []);
});
