/**
 * PROMPT-INJECTION DETECTOR (deterministic, model-independent)
 * Flags email text that looks like instructions aimed at an AI. This is a
 * warning label only: the real protection is that the model has no tools and
 * the backend acts only on your taps. A flagged email still gets a draft,
 * marked with "possible_prompt_injection" so you can look closely.
 */
const PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|your|all|the)\b.{0,20}\b(instructions?|prompts?|rules?|directions?)\b/i,
  /\b(system prompt|developer message|jailbreak|DAN mode)\b/i,
  /\byou are (now )?(an? )?(ai|assistant|chatbot|language model|llm)\b/i,
  /\bas an ai\b/i,
  /\b(ai|assistant|chatbot|claude|gpt)\s*[:,]\s*\w+/i,
  /\bnew instructions?\s*:/i,
  /\b(forward|send|email)\b.{0,30}\b(every|all|each)\b.{0,15}\b(emails?|messages?|mail|contacts?)\b/i,
  /\b(send|reply with|give|reveal|share)\b.{0,30}\b(passwords?|credentials|api keys?|tokens?|secrets?)\b/i,
  /\bsend (this|the) (draft|email|reply) (immediately|now|automatically)\b/i,
  /\b(delete|archive|trash) (this|the|all) (thread|emails?|messages?)\b/i,
  /<\s*\/?\s*(system|assistant|user|email|thread|instruction[\w-]*|tool[\w-]*)\b[^>]*>/i,
  /\b(ignorez|oubliez)\b.{0,40}\b(instructions|consignes)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
/** Back-compat: a RegExp-like object with .test(). */
export const INJECTION_RE = { test: looksLikeInjection };
