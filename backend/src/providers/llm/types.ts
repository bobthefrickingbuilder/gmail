/**
 * LLM PROVIDER INTERFACE
 * Text in, JSON out. Deliberately has NO tool-calling capability: the model
 * can only return data, never act. See SECURITY.md.
 */
import type { z } from "zod";

export interface LlmRequest<T extends z.ZodType> {
  modelKey: string;
  purpose: "triage" | "draft" | "profile" | "seed" | "learn" | "eval";
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
}
