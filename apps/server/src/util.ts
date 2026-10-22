import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { LIMITS } from "../../../packages/domain/src/limits.ts";

const scryptAsync = promisify(scrypt);

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashToken(token: string): string {
  return sha256(token);
}

export function newPassageId(): string {
  return `psg_${randomBytes(8).toString("hex")}`;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const key = (await scryptAsync(password, salt, expected.length)) as Buffer;
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

export function cleanTitle(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.maxTitleChars);
  return cleaned || fallback.slice(0, LIMITS.maxTitleChars);
}

export function asJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : "error";
  return message.replace(/[\u0000-\u001f]/g, " ").slice(0, 300);
}

export function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

export function safeFilename(name: string | null | undefined): string {
  const cleaned = (name ?? "source").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned || "source";
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}
