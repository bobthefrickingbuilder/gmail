export function when(iso: string): string {
  const d = new Date(iso); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
export const dateTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const who = (a: { name: string | null; email: string }) => a.name || a.email;
export const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
export const modelLabel = (k: string | null) => (k ? k[0].toUpperCase() + k.slice(1) : "");
export const FLAG_LABELS: Record<string, string> = {
  possible_prompt_injection: "Possible prompt injection", asks_for_money: "Asks for money", requests_sensitive_info: "Requests sensitive info",
  legal_or_contract: "Legal / contract", requests_personal_schedule: "Asks about your schedule", emotional_or_sensitive: "Sensitive topic",
  filler_words: "Filler words", possible_schedule_disclosure: "May reveal your schedule", served_by_fallback_model: "Answered by fallback model",
};
export const flagLabel = (f: string) => FLAG_LABELS[f] ?? f.replace(/_/g, " ");
