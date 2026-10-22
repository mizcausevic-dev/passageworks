import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import test from "node:test";
import { createApp } from "../src/app.ts";
import type { Ctx } from "../src/ctx.ts";
import { migrate, openPglite } from "../src/db.ts";
import { processNext } from "../src/ingest.ts";
import { MemoryStore } from "../src/storage.ts";

const LOCKED_PDF = Buffer.from(
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDhkYTJjMDgwZTI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YjY1NjkxOGIyOTdlMzczODQwOTdlNTlkZTY0MmZkMTYxMDJkMjBlMTYxNjcyNGZhN2MyMmNlOWQ3ZTYxOWM3YT4KL1UgPGZjNzBhMDlmZjM1NzRkY2Q5NjY1ODM5NDRiYjhkYzgzMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjYzNTYxNjY2MTY1NjYzMTMxPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK",
  "base64",
);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function boot(): Promise<{ ctx: Ctx; app: ReturnType<typeof createApp>; calls: string[] }> {
  const calls: string[] = [];
  const db = await openPglite();
  await migrate(db);
  const ctx: Ctx = {
    db,
    storage: new MemoryStore(),
    lookup: async (hostname) => {
      if (hostname === "evil.example") return [{ address: "10.1.1.1", family: 4 }];
      return [{ address: "8.8.8.8", family: 4 }];
    },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/redirect")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
      }
      if (url.includes("/circular")) {
        return new Response(
          `<!doctype html><html><head><title>Northglass Circular</title></head><body><script>alert(1)</script><h1>Circular</h1><p>Visitors must stay clear of the veldtide gauge.</p><a href="javascript:alert(1)">x</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("missing", { status: 500 });
    },
    ai: null,
    workerId: "test",
    cookieSecure: false,
    limitsEnabled: false,
    backoffMs: () => 0,
  };
  return { ctx, app: createApp(ctx), calls };
}

async function drain(ctx: Ctx) {
  for (let i = 0; i < 12; i += 1) {
    if (!(await processNext(ctx))) return;
  }
  throw new Error("jobs did not settle");
}

function cookieFrom(res: Response): string {
  const list = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const found = list.find((item) => item.startsWith("pw_session="));
  if (!found) throw new Error(`no session cookie in ${list.join(" | ")}`);
  return found.split(";")[0] ?? "";
}

async function send(app: ReturnType<typeof createApp>, path: string, init: {
  method?: string;
  cookie?: string;
  json?: unknown;
  form?: FormData;
} = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await app.request(path, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, raw: text };
}

async function register(app: ReturnType<typeof createApp>, email: string, name = "Tester") {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct-horse-battery" }),
  });
  const body = await res.json() as { user: { id: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  return { cookie: cookieFrom(res), user: body.user };
}

async function textPdf(sentence: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawText(sentence, { x: 72, y: 720, size: 12, font, color: rgb(0, 0, 0) });
  return doc.save();
}

async function scanPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const image = await doc.embedPng(PNG);
  page.drawImage(image, { x: 40, y: 40, width: 80, height: 80 });
  return doc.save();
}

test("ingestion, search, concurrency, sharing, and workspace isolation", async () => {
  const { ctx, app, calls } = await boot();
  const owner = await register(app, "owner@northglass.example", "Owner");
  const created = await send(app, "/api/workspaces", { method: "POST", cookie: owner.cookie, json: { name: "Northglass" } });
  assert.equal(created.status, 201);
  const workspaceId = (created.body.workspace as { id: string }).id;
  const projectRes = await send(app, `/api/workspaces/${workspaceId}/projects`, {
    method: "POST",
    cookie: owner.cookie,
    json: { name: "Basin notes", description: "Fictional" },
  });
  const projectId = (projectRes.body.project as { id: string }).id;

  const pdf = await textPdf("The veldtide gauge recorded a morning stage at the lower footbridge.");
  const form = new FormData();
  form.set("title", "Methods note");
  form.set("file", new File([Buffer.from(pdf)], "notes.txt", { type: "text/plain" }));
  const uploaded = await send(app, `/api/projects/${projectId}/sources/file`, { method: "POST", cookie: owner.cookie, form });
  assert.equal(uploaded.status, 202, JSON.stringify(uploaded.body));
  await drain(ctx);
  const sourceId = String(uploaded.body.sourceId);
  const source = await send(app, `/api/sources/${sourceId}`, { cookie: owner.cookie });
  assert.equal(source.status, 200);
  const version = source.body.version as { outcome: string; contentText: string; chunks: { passageId: string; pageNumber: number | null; text: string }[] };
  assert.equal(version.outcome, "extracted");
  assert.match(version.contentText, /veldtide gauge/);
  assert.equal(version.chunks[0]?.pageNumber, 1);
  assert.equal(JSON.stringify(source.body).includes("storage_key"), false);
  const passageId = version.chunks[0]?.passageId ?? "";

  const scan = await scanPdf();
  const scanForm = new FormData();
  scanForm.set("title", "Plate 7");
  scanForm.set("file", new File([Buffer.from(scan)], "plate-7.pdf", { type: "application/pdf" }));
  const scanUp = await send(app, `/api/projects/${projectId}/sources/file`, { method: "POST", cookie: owner.cookie, form: scanForm });
  assert.equal(scanUp.status, 202);
  await drain(ctx);
  const scanSource = await send(app, `/api/sources/${String(scanUp.body.sourceId)}`, { cookie: owner.cookie });
  const scanVersion = scanSource.body.version as { outcome: string; contentText: string; ocrRequired: boolean };
  assert.equal(scanVersion.outcome, "ocr_required");
  assert.equal(scanVersion.ocrRequired, true);
  assert.equal(scanVersion.contentText, "");

  const lockedForm = new FormData();
  lockedForm.set("title", "Locked");
  lockedForm.set("file", new File([LOCKED_PDF], "locked.pdf", { type: "application/pdf" }));
  const lockedUp = await send(app, `/api/projects/${projectId}/sources/file`, { method: "POST", cookie: owner.cookie, form: lockedForm });
  await drain(ctx);
  const lockedSource = await send(app, `/api/sources/${String(lockedUp.body.sourceId)}`, { cookie: owner.cookie });
  const lockedVersion = lockedSource.body.version as { passwordProtected: boolean; contentText: string };
  const jobs = lockedSource.body.jobs as { status: string; error_code: string | null }[];
  assert.equal(lockedVersion.passwordProtected, true);
  assert.equal(lockedVersion.contentText, "");
  assert.equal(jobs[0]?.status, "failed");
  assert.equal(jobs[0]?.error_code, "password_protected");

  const pngForm = new FormData();
  pngForm.set("file", new File([PNG], "fake.pdf", { type: "application/pdf" }));
  const pngUp = await send(app, `/api/projects/${projectId}/sources/file`, { method: "POST", cookie: owner.cookie, form: pngForm });
  assert.equal(pngUp.status, 400);
  assert.equal((pngUp.body as { error: string }).error, "mime_mismatch");

  const noted = await send(app, `/api/projects/${projectId}/sources/note`, {
    method: "POST",
    cookie: owner.cookie,
    json: { title: "Reminder", text: "Ask whether the veldtide gauge was re-leveled after the March storm." },
  });
  assert.equal(noted.status, 202);
  const queuedUrl = await send(app, `/api/projects/${projectId}/sources/url`, {
    method: "POST",
    cookie: owner.cookie,
    json: { url: "https://archive.northglass.example/circular", title: "Circular" },
  });
  assert.equal(queuedUrl.status, 202);
  const blockedUrl = await send(app, `/api/projects/${projectId}/sources/url`, {
    method: "POST",
    cookie: owner.cookie,
    json: { url: "http://127.0.0.1/latest" },
  });
  assert.equal(blockedUrl.status, 400);
  assert.equal((blockedUrl.body as { error: string }).error, "ssrf_blocked");
  const redirectJob = await send(app, `/api/projects/${projectId}/sources/url`, {
    method: "POST",
    cookie: owner.cookie,
    json: { url: "https://archive.northglass.example/redirect" },
  });
  await drain(ctx);
  const redirectSource = await send(app, `/api/sources/${String(redirectJob.body.sourceId)}`, { cookie: owner.cookie });
  assert.equal((redirectSource.body.source as { outcome: string }).outcome, "failed");
  assert.equal(calls.includes("http://127.0.0.1/secret"), false);
  const circular = await send(app, `/api/sources/${String(queuedUrl.body.sourceId)}`, { cookie: owner.cookie });
  const circularHtml = (circular.body.version as { contentHtml: string; contentText: string }).contentHtml;
  assert.equal(circularHtml.includes("<script"), false);
  assert.match((circular.body.version as { contentText: string }).contentText, /veldtide gauge/);

  const annotation = await send(app, `/api/sources/${sourceId}/annotations`, {
    method: "POST",
    cookie: owner.cookie,
    json: { passageId, quote: "veldtide gauge", note: "Check the stage reading." },
  });
  assert.equal(annotation.status, 201, JSON.stringify(annotation.body));
  const saved = annotation.body.annotation as { pageNumber: number | null; charStart: number | null };
  assert.equal(saved.pageNumber, 1);
  assert.equal(typeof saved.charStart, "number");
  const invented = await send(app, `/api/sources/${sourceId}/annotations`, {
    method: "POST",
    cookie: owner.cookie,
    json: { passageId, quote: "veldtide gauge", note: "no", pageNumber: 9 },
  });
  assert.equal(invented.status, 400);
  assert.equal((invented.body as { error: string }).error, "page_unknown");

  const found = await send(app, `/api/projects/${projectId}/search?q=${encodeURIComponent("lower footbridge")}`, { cookie: owner.cookie });
  assert.equal(found.status, 200);
  const results = found.body.results as { passageId: string | null; snippet: string }[];
  assert.ok(results.some((result) => result.passageId === passageId));
  assert.match(results.find((result) => result.passageId === passageId)?.snippet ?? "", /<mark>/);
  assert.equal(found.body.semantic && (found.body.semantic as { status: string }).status, "unavailable");

  const outsider = await register(app, "outsider@other.example", "Outsider");
  const otherWs = await send(app, "/api/workspaces", { method: "POST", cookie: outsider.cookie, json: { name: "Other" } });
  const otherProject = await send(app, `/api/workspaces/${(otherWs.body.workspace as { id: string }).id}/projects`, {
    method: "POST",
    cookie: outsider.cookie,
    json: { name: "Private", description: "" },
  });
  const otherProjectId = (otherProject.body.project as { id: string }).id;
  await send(app, `/api/projects/${otherProjectId}/sources/note`, {
    method: "POST",
    cookie: outsider.cookie,
    json: { title: "Secret mineral", text: "The sample code is lumenquartz and it stays in this workspace." },
  });
  await drain(ctx);
  const leak = await send(app, `/api/projects/${projectId}/search?q=lumenquartz`, { cookie: owner.cookie });
  assert.equal((leak.body.results as unknown[]).length, 0);
  const cross = await send(app, `/api/sources/${sourceId}`, { cookie: outsider.cookie });
  assert.equal(cross.status, 404);
  const outsiderSearch = await send(app, `/api/projects/${otherProjectId}/search?q=lumenquartz`, { cookie: outsider.cookie });
  assert.ok(((outsiderSearch.body.results as unknown[]) ?? []).length > 0);

  const brief = await send(app, `/api/projects/${projectId}/documents`, {
    method: "POST",
    cookie: owner.cookie,
    json: {
      kind: "brief",
      title: "Stage brief",
      bodyHtml: `<p>The log names the veldtide gauge. <cite data-passage-id="${passageId}">${passageId}</cite></p>`,
    },
  });
  assert.equal(brief.status, 201, JSON.stringify(brief.body));
  const doc = brief.body.document as { id: string; revision: number; bodyHtml: string };
  const stale = await send(app, `/api/documents/${doc.id}`, {
    method: "PATCH",
    cookie: owner.cookie,
    json: { baseRevision: doc.revision, title: "Stage brief revised", bodyHtml: doc.bodyHtml },
  });
  assert.equal(stale.status, 200);
  const conflict = await send(app, `/api/documents/${doc.id}`, {
    method: "PATCH",
    cookie: owner.cookie,
    json: { baseRevision: doc.revision, title: "Lost update", bodyHtml: "<p>overwrite</p>" },
  });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { error: string }).error, "revision_conflict");
  assert.notEqual((conflict.body.details as { document: { title: string } }).document.title, "Lost update");

  const unavailable = await send(app, `/api/documents/${doc.id}/generate`, {
    method: "POST",
    cookie: owner.cookie,
    json: { instruction: "Summarize the gauge reading", apply: true, baseRevision: 1 },
  });
  assert.equal(unavailable.status, 503);
  assert.equal((unavailable.body as { error: string }).error, "ai_unavailable");
  const after = await send(app, `/api/documents/${doc.id}`, { cookie: owner.cookie });
  assert.match((after.body.document as { bodyHtml: string }).bodyHtml, /veldtide gauge/);

  const hidden = await send(app, `/api/documents/${doc.id}/shares`, {
    method: "POST",
    cookie: owner.cookie,
    json: { days: 3, exposeCitedPassages: false },
  });
  const hiddenToken = (hidden.body.share as { token: string; id: string }).token;
  const hiddenRead = await send(app, `/api/shared/${hiddenToken}`);
  assert.equal(hiddenRead.status, 200);
  assert.equal(hiddenRead.body.exposeCitedPassages, false);
  assert.equal(JSON.stringify(hiddenRead.body).includes(passageId), false);
  assert.equal(JSON.stringify(hiddenRead.body).includes("lower footbridge"), false);

  const open = await send(app, `/api/documents/${doc.id}/shares`, {
    method: "POST",
    cookie: owner.cookie,
    json: { days: 2, exposeCitedPassages: true },
  });
  const openToken = (open.body.share as { token: string; id: string }).token;
  const openId = (open.body.share as { id: string }).id;
  const openRead = await send(app, `/api/shared/${openToken}`);
  assert.equal(openRead.body.exposeCitedPassages, true);
  const citations = openRead.body.citations as { quote: string }[];
  assert.match(citations[0]?.quote ?? "", /veldtide gauge/);
  assert.equal(JSON.stringify(openRead.body).includes("lumenquartz"), false);
  const revoked = await send(app, `/api/shares/${openId}/revoke`, { method: "POST", cookie: owner.cookie });
  assert.equal(revoked.status, 200);
  const denied = await send(app, `/api/shared/${openToken}`);
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "share_revoked");

  const viewer = await register(app, "viewer@northglass.example", "Viewer");
  await send(app, `/api/workspaces/${workspaceId}/members`, {
    method: "POST",
    cookie: owner.cookie,
    json: { email: "viewer@northglass.example", role: "viewer" },
  });
  const forbidden = await send(app, `/api/documents/${doc.id}`, {
    method: "PATCH",
    cookie: viewer.cookie,
    json: { baseRevision: 2, title: "Nope", bodyHtml: "<p>no</p>" },
  });
  assert.equal(forbidden.status, 403);
  const download = await send(app, `/api/sources/${sourceId}/file`, { cookie: viewer.cookie });
  assert.equal(download.status, 403);

  ctx.ai = {
    provider: "scripted",
    model: "scripted-brief",
    async generate() {
      return {
        text: `The veldtide gauge is named in the method note. [[${passageId}]]\n\nA ridge sensor reported a conflicting stage that these passages do not contain.\n\nBad marker [[psg_deadbeefdeadbeef]]`,
        model: "scripted-brief-v1",
        usage: { completion_tokens: 12 },
      };
    },
  };
  const current = await send(app, `/api/documents/${doc.id}`, { cookie: owner.cookie });
  const revision = (current.body.document as { revision: number }).revision;
  const generated = await send(app, `/api/documents/${doc.id}/generate`, {
    method: "POST",
    cookie: owner.cookie,
    json: { instruction: "veldtide gauge", passageIds: [passageId], apply: true, baseRevision: revision },
  });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  const flags = generated.body.flags as { type: string }[];
  assert.ok(flags.some((flag) => flag.type === "unsupported_claim"));
  assert.ok(flags.some((flag) => flag.type === "unknown_citation"));
  assert.equal(JSON.stringify(generated.body.draftHtml).includes("psg_deadbeefdeadbeef"), false);
  assert.equal(generated.body.model, "scripted-brief-v1");
  assert.match(String(generated.body.disclosure), /does not prove/);
  const applied = await send(app, `/api/documents/${doc.id}`, { cookie: owner.cookie });
  assert.match((applied.body.document as { bodyHtml: string }).bodyHtml, new RegExp(passageId));
});
