import { isIP, BlockList } from "node:net";
import { Agent } from "undici";
import { LIMITS } from "../../../packages/domain/src/limits.ts";
import { IngestError } from "./errors.ts";

const block = new BlockList();
for (const [cidr, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  block.addSubnet(cidr, bits, "ipv4");
}
block.addAddress("255.255.255.255", "ipv4");
block.addAddress("::", "ipv6");
block.addAddress("::1", "ipv6");
block.addSubnet("fc00::", 7, "ipv6");
block.addSubnet("fe80::", 10, "ipv6");
block.addSubnet("ff00::", 8, "ipv6");
block.addSubnet("2001:db8::", 32, "ipv6");

const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "metadata.goog"]);

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export type FetchLike = (
  url: string,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

export async function defaultLookup(hostname: string): Promise<{ address: string; family: number }[]> {
  const { lookup } = await import("node:dns/promises");
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family }));
}

export function assertPublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new IngestError("invalid_url", false, "The URL could not be parsed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new IngestError("ssrf_blocked", false, "Only public http and https URLs can be fetched");
  }
  if (url.username || url.password) {
    throw new IngestError("ssrf_blocked", false, "URLs with embedded credentials are refused");
  }
  if (url.href.length > LIMITS.maxUrlChars) {
    throw new IngestError("invalid_url", false, "The URL is too long");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new IngestError("ssrf_blocked", false, "Only ports 80 and 443 can be fetched");
  }
  const host = url.hostname.toLowerCase();
  if (!host || host.endsWith(".") || isBlockedHostname(host)) {
    throw new IngestError("ssrf_blocked", false, "That host is not a public destination");
  }
  const literal = literalIp(host);
  if (literal && isBlockedIp(literal.address, literal.family)) {
    throw new IngestError("ssrf_blocked", false, "That address is not public");
  }
  return url;
}

export function isBlockedHostname(host: string): boolean {
  const name = host.toLowerCase();
  if (BLOCKED_NAMES.has(name)) return true;
  return name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal");
}

export function isBlockedIp(address: string, family: 4 | 6): boolean {
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const mapped = mappedV4(groups);
    if (mapped) return isBlockedIp(mapped, 4);
    return block.check(address, "ipv6");
  }
  if (!isIP(address)) return true;
  return block.check(address, "ipv4");
}

export async function safeFetch(
  input: string,
  deps: { fetchImpl: FetchLike; lookup: LookupFn },
): Promise<{ finalUrl: string; status: number; contentType: string; body: Uint8Array }> {
  let current = input;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
    const url = assertPublicUrl(current);
    const pinned = await resolvePinned(url.hostname.toLowerCase(), deps.lookup);
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        },
      },
    });
    let response: Response;
    try {
      response = await deps.fetchImpl(url.href, {
        redirect: "manual",
        dispatcher,
        cache: "no-store",
        signal: AbortSignal.timeout(LIMITS.maxFetchMs),
        headers: {
          accept: "text/html, text/plain, application/pdf;q=0.9,*/*;q=0.1",
          "user-agent": "PassageworksFetcher/1.0",
        },
      });
    } catch (error) {
      await dispatcher.close().catch(() => undefined);
      if (error instanceof IngestError) throw error;
      throw new IngestError("fetch_failed", true, "The page could not be fetched");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      if (!location) throw new IngestError("fetch_failed", false, "Redirect was missing a location");
      if (hop === LIMITS.maxRedirects) {
        throw new IngestError("redirect_limit", false, "Too many redirects");
      }
      current = new URL(location, url).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      throw new IngestError(
        "fetch_failed",
        response.status >= 500,
        `The page responded with status ${response.status}`,
      );
    }
    try {
      const body = await readCapped(response, LIMITS.maxHttpBytes);
      const contentType = (response.headers.get("content-type") ?? "").slice(0, 200);
      return { finalUrl: url.href, status: response.status, contentType, body };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
  throw new IngestError("redirect_limit", false, "Too many redirects");
}

async function resolvePinned(hostname: string, lookup: LookupFn): Promise<{ address: string; family: 4 | 6 }> {
  const literal = literalIp(hostname);
  if (literal) {
    if (isBlockedIp(literal.address, literal.family)) {
      throw new IngestError("ssrf_blocked", false, "That address is not public");
    }
    return publicForm(literal.address, literal.family);
  }
  let records: { address: string; family: number }[];
  try {
    records = await lookup(hostname);
  } catch {
    throw new IngestError("dns_failed", true, "DNS lookup failed");
  }
  if (records.length === 0) throw new IngestError("dns_failed", true, "DNS lookup returned no addresses");
  const checked = records.map((record) => {
    const family: 4 | 6 = record.family === 6 ? 6 : 4;
    if (isBlockedIp(record.address, family)) {
      throw new IngestError("ssrf_blocked", false, "DNS resolved to a non-public address");
    }
    return publicForm(record.address, family);
  });
  const first = checked[0];
  if (!first) throw new IngestError("dns_failed", true, "DNS lookup returned no addresses");
  return first;
}

function publicForm(address: string, family: 4 | 6): { address: string; family: 4 | 6 } {
  if (family === 6) {
    const groups = ipv6Groups(address);
    const mapped = groups ? mappedV4(groups) : null;
    if (mapped) {
      if (isBlockedIp(mapped, 4)) throw new IngestError("ssrf_blocked", false, "That address is not public");
      return { address: mapped, family: 4 };
    }
  }
  return { address, family };
}

function literalIp(hostname: string): { address: string; family: 4 | 6 } | null {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  if (family === 4) return { address: bare, family: 4 };
  if (family === 6) return { address: bare, family: 6 };
  return null;
}

function ipv6Groups(input: string): number[] | null {
  let host = input.toLowerCase().split("%")[0] ?? "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(".")) {
    const last = host.lastIndexOf(":");
    const parts = host.slice(last + 1).split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const hi = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const lo = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    host = `${host.slice(0, last + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const nums = groups.map((group) => (group === "" ? Number.NaN : Number.parseInt(group, 16)));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 0xffff)) return null;
  return nums;
}

function mappedV4(groups: number[]): string | null {
  const prefixEmpty = groups.slice(0, 5).every((group) => group === 0);
  if (!prefixEmpty || groups[5] !== 0xffff) return null;
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new IngestError("response_too_large", false, "The response exceeded the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError("fetch_failed", true, "The response could not be read");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
