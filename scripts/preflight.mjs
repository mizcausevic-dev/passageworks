import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const root = "apps/web/dist";
const allowed = new Set([".html", ".js", ".css", ".map", ".svg", ".json", ".txt", ".pdf", ".woff2", ".png", ".ico", ".webmanifest"]);
const banned = [/AI_API_KEY\s*=\s*\S+/, /BEGIN (RSA |OPENSSH )?PRIVATE KEY/, /postgres:\/\/[^@\s]+:[^@\s]+@/];
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    const ext = extname(name);
    if (!allowed.has(ext)) failures.push(`disallowed file ${path}`);
    if (name.startsWith(".env")) failures.push(`env file in web dist ${path}`);
    const text = readFileSync(path);
    const sample = text.subarray(0, Math.min(text.length, 2_000_000)).toString("utf8");
    for (const pattern of banned) {
      if (pattern.test(sample)) failures.push(`secret-like pattern in ${path}`);
    }
  }
}

walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({ event: "preflight_ok", root }));
