import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createRuntime } from "./runtime.ts";
import { seedDemo } from "./seed.ts";

const ctx = await createRuntime();
if (process.env.SEED_DEMO === "true") {
  console.log(JSON.stringify({
    event: "seed_demo_enabled",
    warning: "Demo accounts are enabled. Do not expose this process to the public internet.",
  }));
  await seedDemo(ctx);
}
const port = Number(process.env.PORT || 8787);
const hostname = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const app = createApp(ctx, { webDist: process.env.WEB_DIST || null });
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(JSON.stringify({ event: "listen", hostname: info.address, port: info.port }));
});
