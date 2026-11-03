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

/** Colour per triage category (CSS variables defined in styles.css). */
export const CAT_HUE: Record<string, string> = {
  urgent: "var(--c-urgent)", "needs-reply": "var(--c-needs)", scheduling: "var(--c-sched)", personal: "var(--c-personal)",
  "invoice/admin": "var(--c-admin)", fyi: "var(--c-fyi)", newsletter: "var(--c-news)", other: "var(--c-other)", uncategorized: "var(--c-other)",
};
export const catHue = (c: string | null | undefined) => CAT_HUE[c ?? "uncategorized"] ?? "var(--c-other)";
export const projectHue = (color: string | null | undefined) => `var(--p-${color ?? "slate"})`;
/** Stable 0-359 hue from a string (same sender → same avatar colour). */
export function hueOf(s: string): number { let h = 0; for (const ch of s.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
export function initials(name: string | null | undefined, email = ""): string {
  const n = (name || email.split("@")[0] || "?").replace(/[^\p{L}\p{N} ._-]/gu, " ").trim();
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
/** "Today", "Tomorrow", "Fri", "Nov 20" for a YYYY-MM-DD due date. */
export function dueLabel(day: string): { text: string; cls: string } {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = day.split("-").map(Number); const due = new Date(y, m - 1, d);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400_000);
  if (diff < 0) return { text: diff === -1 ? "Yesterday" : due.toLocaleDateString([], { month: "short", day: "numeric" }), cls: "late" };
  if (diff === 0) return { text: "Today", cls: "today" };
  if (diff === 1) return { text: "Tomorrow", cls: "" };
  if (diff < 7) return { text: due.toLocaleDateString([], { weekday: "short" }), cls: "" };
  return { text: due.toLocaleDateString([], { month: "short", day: "numeric", ...(y !== today.getFullYear() ? { year: "numeric" } : {}) }), cls: "" };
}
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
