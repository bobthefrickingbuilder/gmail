/**
 * SENSITIVE-DATA FILTER
 * Profiles must never store health information, financial account numbers,
 * government ID numbers or similar. Everything the model (or you) writes into
 * a profile passes through here first. Matching sentences/items are removed
 * and the removal is reported (without the removed text) so you can see it.
 */

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "government_id", re: /\b(SIN|social insurance|social security|SSN|passport|health card|OHIP|driver'?s licen[cs]e|permis de conduire|NAS|numéro d'assurance sociale)\b/i },
  { kind: "government_id", re: /\b\d{3}[- ]\d{3}[- ]\d{3}\b/ },                       // SIN-like
  { kind: "government_id", re: /\b\d{3}-\d{2}-\d{4}\b/ },                              // SSN-like
  { kind: "financial", re: /\b(?:\d[ -]?){13,19}\b/ },                                 // card-like digit runs
  { kind: "financial", re: /\b(bank account|account number|routing number|transit number|IBAN|SWIFT|credit card|carte de crédit|numéro de compte|PIN)\b/i },
  { kind: "financial", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/ },                         // IBAN-like
  { kind: "health", re: /\b(diagnos(is|ed)|medication|prescri(bed|ption)|illness|disease|cancer|chemo|surgery|therapy|therapist|depress(ion|ed)|anxiety disorder|pregnan(t|cy)|disabilit(y|ies)|HIV|diabetes|mental health|hospitali[sz]ed|maladie|médicament|grossesse|santé mentale)\b/i },
  { kind: "credential", re: /\b(password|mot de passe|passcode|api key|secret key)\b/i },
];

export interface FilterReport { removed: { field: string; kind: string }[] }

export function sensitiveKind(text: string): string | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.kind;
  return null;
}

/** Remove sentences containing sensitive data from free text. */
export function scrubText(text: string, field: string, report: FilterReport): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const kept = sentences.filter((s) => {
    const k = sensitiveKind(s);
    if (k) report.removed.push({ field, kind: k });
    return !k;
  });
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

export function scrubList<T>(items: T[], field: string, report: FilterReport, toText: (t: T) => string = (t) => String(t)): T[] {
  return items.filter((it) => {
    const k = sensitiveKind(toText(it));
    if (k) report.removed.push({ field, kind: k });
    return !k;
  });
}
