import type { Db } from "./db.ts";
import type { FetchLike, LookupFn } from "./ssrf.ts";
import type { ObjectStore } from "./storage.ts";

export interface AiClient {
  provider: string;
  model: string;
  generate(input: { system: string; user: string }): Promise<{
    text: string;
    model: string;
    usage: Record<string, unknown> | null;
  }>;
}

export type Ctx = {
  db: Db;
  storage: ObjectStore;
  lookup: LookupFn;
  fetchImpl: FetchLike;
  ai: AiClient | null;
  workerId: string;
  cookieSecure: boolean;
  limitsEnabled: boolean;
  backoffMs: (attempt: number) => number;
  beforePersist?: (jobId: string) => Promise<void>;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};
