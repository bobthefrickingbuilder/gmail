/**
 * LLM PROVIDER INTERFACE
 * `complete()` — text in, JSON out, NO tools: triage, drafting, profiles and
 * the worker only ever use this, so for them the model can only return data.
 * `chat()` — the in-app chat (chat/service.ts) only. Tools are offered there,
 * but the model can only REQUEST a tool; chat/tools.ts decides what runs, and
 * no tool can send email. See SECURITY.md ("In-app chat").
 */
import type { z } from "zod";

export interface LlmRequest<T extends z.ZodType> {
  modelKey: string;
  purpose: "triage" | "draft" | "profile" | "seed" | "learn" | "eval" | "task";
  system: string;
  user: string;
  schema: T;
  /** Name for the JSON schema (shown to the model). */
  schemaName: string;
  maxTokens: number;
}

export interface LlmResult<T> {
  data: T;
  modelKey: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  attempts: number;
  /** true when the API's server-side fallback answered instead of the requested model */
  fellBack: boolean;
}

export class LlmOutputError extends Error {
  constructor(msg: string, public readonly raw?: string) { super(msg); }
}
export class LlmRefusalError extends Error {
  constructor(public readonly category: string | null) { super(`Model declined the request${category ? ` (${category})` : ""}`); }
}

export interface LlmProvider {
  readonly kind: string;
  complete<T extends z.ZodType>(req: LlmRequest<T>): Promise<LlmResult<z.infer<T>>>;
  /** One model turn of the in-app chat. The caller runs any requested tools and loops. */
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---------- chat with tools (in-app chat only) ----------

/** A tool the chat model may ask for. `input_schema` is JSON Schema. */
export interface ChatToolDef { name: string; description: string; input_schema: Record<string, unknown> }

/**
 * One content block, in the Messages API shape. Text, tool_use and tool_result
 * are read by the app; anything else the model returns (thinking, fallback…)
 * is stored and passed back unchanged so the history stays append-only.
 */
export type ChatBlock = { type: string; [k: string]: unknown };
export interface ChatTextBlock { type: "text"; text: string }
export interface ChatToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export interface ChatToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export const isText = (b: ChatBlock): b is ChatBlock & ChatTextBlock => b.type === "text" && typeof b.text === "string";
export const isToolUse = (b: ChatBlock): b is ChatBlock & ChatToolUseBlock => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string";

export interface ChatMessage { role: "user" | "assistant"; content: ChatBlock[] }

export interface ChatRequest {
  modelKey: string;
  system: string;
  messages: ChatMessage[];
  tools: ChatToolDef[];
  maxTokens: number;
}

export interface ChatResponse {
  content: ChatBlock[];
  /** end_turn | tool_use | max_tokens | refusal | pause_turn | … */
  stopReason: string;
  modelKey: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  fellBack: boolean;
}
