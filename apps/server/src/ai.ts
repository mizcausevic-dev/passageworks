import type { AiClient } from "./ctx.ts";

export function loadAiFromEnv(env: NodeJS.ProcessEnv): AiClient | null {
  const base = env.AI_BASE_URL?.trim() ?? "";
  const key = env.AI_API_KEY?.trim() ?? "";
  const model = env.AI_MODEL?.trim() ?? "";
  const any = Boolean(base || key || model);
  const all = Boolean(base && key && model);
  if (!any) return null;
  if (!all) {
    throw new Error("Set AI_BASE_URL, AI_API_KEY, and AI_MODEL together, or leave all three empty");
  }
  const url = new URL(base);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("AI_BASE_URL must use https, or http only on localhost");
  }
  if (url.username || url.password) throw new Error("AI_BASE_URL must not include credentials");
  return new OpenAiCompatible(url.toString().replace(/\/$/, ""), key, model);
}

class OpenAiCompatible implements AiClient {
  readonly provider = "openai-compatible";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(input: { system: string; user: string }): Promise<{
    text: string;
    model: string;
    usage: Record<string, unknown> | null;
  }> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`provider_status_${response.status}`);
    }
    const payload = (await response.json()) as {
      model?: unknown;
      usage?: unknown;
      choices?: { message?: { content?: unknown } }[];
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("empty_generation");
    const usage = isRecord(payload.usage) ? payload.usage : null;
    return {
      text,
      model: typeof payload.model === "string" ? payload.model : this.model,
      usage,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
