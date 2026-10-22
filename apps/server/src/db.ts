import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

export interface Db {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec?: (sql: string) => Promise<unknown>;
};

function adapt(client: Queryable, tx?: Db["tx"]): Db {
  return {
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return result.rows as never;
    },
    async exec(sql) {
      if (client.exec) await client.exec(sql);
      else await client.query(sql);
    },
    tx: tx ?? (async () => {
      throw new Error("nested transaction is not supported");
    }),
  };
}

export async function openPglite(dir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = dir ? new PGlite(dir) : new PGlite();
  return adapt(client, async (fn) => client.transaction(async (tx) => fn(adapt(tx))));
}

export function openPool(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 10 });
  return adapt(pool, async (fn) => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(adapt(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations/001_init.sql",
);

export async function migrate(db: Db): Promise<void> {
  const sql = readFileSync(migrationPath, "utf8");
  const existing = await db.query<{ name: string | null }>(
    "SELECT to_regclass('public.schema_migrations') AS name",
  );
  if (!existing[0]?.name) {
    await db.exec(sql);
    await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", ["001_init.sql"]);
    return;
  }
  const applied = await db.query("SELECT id FROM schema_migrations WHERE id = $1", ["001_init.sql"]);
  if (applied.length === 0) {
    await db.exec(sql);
    await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", ["001_init.sql"]);
  }
}
