import type { Ctx, SessionUser } from "./ctx.ts";
import { HttpError } from "./errors.ts";
import { hashPassword, hashToken, isUniqueViolation, newToken, verifyPassword } from "./util.ts";

const SESSION_DAYS = 14;
const buckets = new Map<string, { count: number; reset: number }>();

export function rateLimit(ctx: Ctx, key: string, limit: number, windowMs: number): void {
  if (!ctx.limitsEnabled) return;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw new HttpError(429, "rate_limited", "Too many requests. Wait and try again.");
}

export async function registerUser(
  ctx: Ctx,
  input: { email: string; name: string; password: string },
): Promise<{ user: SessionUser; token: string }> {
  const email = input.email.toLowerCase();
  try {
    const rows = await ctx.db.query<{ id: string; email: string; name: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name`,
      [email, input.name.trim(), await hashPassword(input.password)],
    );
    const user = rows[0];
    if (!user) throw new HttpError(500, "internal", "Could not create the account");
    const token = await createSession(ctx, user.id);
    return { user, token };
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, "email_taken", "An account with that email already exists");
    throw error;
  }
}

export async function loginUser(
  ctx: Ctx,
  input: { email: string; password: string },
): Promise<{ user: SessionUser; token: string }> {
  rateLimit(ctx, `login:${input.email.toLowerCase()}`, 20, 15 * 60 * 1000);
  const rows = await ctx.db.query<{ id: string; email: string; name: string; password_hash: string }>(
    `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
    [input.email.toLowerCase()],
  );
  const user = rows[0];
  const ok = await verifyPassword(input.password, user?.password_hash ?? (await hashPassword("not-the-password")));
  if (!user || !ok) throw new HttpError(401, "invalid_login", "Email or password is wrong");
  const token = await createSession(ctx, user.id);
  return { user: { id: user.id, email: user.email, name: user.name }, token };
}

export async function logoutToken(ctx: Ctx, token: string | undefined): Promise<void> {
  if (!token) return;
  await ctx.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function userFromToken(ctx: Ctx, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await ctx.db.query<SessionUser>(
    `SELECT u.id, u.email, u.name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

async function createSession(ctx: Ctx, userId: string): Promise<string> {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await ctx.db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expires],
  );
  return token;
}
