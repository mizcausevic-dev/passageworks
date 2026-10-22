import { processNext } from "./ingest.ts";
import { createRuntime } from "./runtime.ts";

const ctx = await createRuntime();
console.log(JSON.stringify({ event: "worker_start", workerId: ctx.workerId }));
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

while (!stopped) {
  const worked = await processNext(ctx);
  if (!worked) await new Promise((resolve) => setTimeout(resolve, 750));
}
