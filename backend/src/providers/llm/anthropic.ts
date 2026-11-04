/**
 * CLAUDE (ANTHROPIC API) PROVIDER
 * --------------------------------
 * complete(): one request — a system prompt + one user message — asking for
 * JSON that matches a schema (Anthropic "structured outputs"). No tools are
 * passed, so triage/drafting cannot take actions; they only return text.
 * chat(): one turn of the in-app chat, with the chat tools offered. The model
 * can only ask for a tool; chat/tools.ts decides whether and how it runs.
 *
 * Reliability:
 *  - The SDK retries rate limits (429), overloads (529) and 5xx with backoff.
 *  - If the JSON still fails our own validation, we retry once, then give up.
 *  - Sonnet/Opus opt into the API's server-side fallback when configured, so a
 *    safety-classifier decline is re-run on a suitable model automatically.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env } from "../../config.js";
import { getModels } from "../../settings.js";
import { priceFor } from "../../usage/cost.js";
import { LlmOutputError, LlmRefusalError, type ChatRequest, type ChatResponse, type LlmProvider, type LlmRequest, type LlmResult } from "./types.js";

export class AnthropicProvider implements LlmProvider {
  readonly kind = "anthropic";
  private client: Anthropic;

  constructor(apiKey = env().ANTHROPIC_API_KEY) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (or enable MOCK_MODE)");
    this.client = new Anthropic({ apiKey, maxRetries: 4, timeout: 120_000 });
  }

  async complete<T extends z.ZodType>(req: LlmRequest<T>): Promise<LlmResult<z.infer<T>>> {
    const models = await getModels();
    const model = models.models[req.modelKey];
    if (!model) throw new Error(`Unknown model key "${req.modelKey}" (check config/models.json)`);

    let inputTokens = 0, outputTokens = 0, lastRaw = "", lastErr = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const userText = attempt === 1 ? req.user
        : `${req.user}\n\nYour previous reply was not valid JSON for the required schema (${lastErr}). Reply again with JSON only.`;
      const response = await this.client.beta.messages.create({
        model: model.id,
        max_tokens: req.maxTokens,
        // Stable rules first, cached; the variable email content goes in the user turn.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userText }],
        output_config: { effort: model.effort, format: zodOutputFormat(req.schema) },
        ...(model.serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const u = response.usage;
      inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      outputTokens += u.output_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        throw new LlmRefusalError((response as { stop_details?: { category?: string | null } }).stop_details?.category ?? null);
      }
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      lastRaw = text;
      if (response.stop_reason === "max_tokens") { lastErr = "output was cut off (max_tokens)"; continue; }
      try {
        const parsed = req.schema.safeParse(JSON.parse(text));
        if (parsed.success) {
          return {
            data: parsed.data, modelKey: req.modelKey, modelId: model.id, inputTokens, outputTokens,
            costUsd: await priceFor(req.modelKey, inputTokens, outputTokens), attempts: attempt,
            fellBack: Boolean(response.model && response.model !== model.id),
          };
        }
        lastErr = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch (e) {
        lastErr = `JSON parse error: ${(e as Error).message}`;
      }
    }
    throw Object.assign(new LlmOutputError(`Model output failed validation twice: ${lastErr}`, lastRaw), { inputTokens, outputTokens });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const models = await getModels();
    const model = models.models[req.modelKey];
    if (!model) throw new Error(`Unknown model key "${req.modelKey}" (check config/models.json)`);
    // History is append-only: earlier assistant turns (including thinking blocks) are sent back exactly as received.
    const response = await this.client.beta.messages.create({
      model: model.id,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages as unknown as Anthropic.Beta.BetaMessageParam[],
      tools: req.tools.map((t, i) => ({ name: t.name, description: t.description,
        input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
        // cache the (static) tool list together with the system prompt
        ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}) })),
      tool_choice: { type: "auto" },
      output_config: { effort: model.effort },
      ...(model.serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const u = response.usage;
    const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const outputTokens = u.output_tokens ?? 0;
    if (response.stop_reason === "refusal") {
      throw new LlmRefusalError((response as { stop_details?: { category?: string | null } }).stop_details?.category ?? null);
    }
    return {
      content: response.content as unknown as ChatResponse["content"], stopReason: response.stop_reason ?? "end_turn",
      modelKey: req.modelKey, modelId: model.id, inputTokens, outputTokens,
      costUsd: await priceFor(req.modelKey, inputTokens, outputTokens),
      fellBack: Boolean(response.model && response.model !== model.id),
    };
  }
}
