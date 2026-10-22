import { randomUUID } from "node:crypto";
import { loadAiFromEnv } from "./ai.ts";
import type { Ctx } from "./ctx.ts";
import { migrate, openPglite, openPool } from "./db.ts";
import { defaultLookup } from "./ssrf.ts";
import { DiskStore } from "./storage.ts";

export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Ctx> {
  if (!env.DATABASE_URL && env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  const db = env.DATABASE_URL ? openPool(env.DATABASE_URL) : await openPglite(env.PGLITE_DIR || ".data/pglite");
  await migrate(db);
  return {
    db,
    storage: new DiskStore(env.STORAGE_ROOT || ".data/storage"),
    lookup: defaultLookup,
    fetchImpl: fetch,
    ai: loadAiFromEnv(env),
    workerId: env.WORKER_ID || randomUUID(),
    cookieSecure: env.COOKIE_SECURE === "true",
    limitsEnabled: env.RATE_LIMIT_DISABLED !== "1",
    backoffMs: (attempt) => 2 ** Math.min(attempt, 6) * 1000,
  };
}
