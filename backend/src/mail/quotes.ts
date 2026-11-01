/**
 * QUOTE & SIGNATURE STRIPPING
 * ---------------------------
 * Replies usually carry the whole previous conversation underneath, plus a
 * signature. We keep all of that in the database, but before sending text to
 * the model we cut it down to "what this person actually wrote this time".
 * That saves tokens and stops the model confusing old text with new.
 * Works for English and French mail clients (Gmail, Outlook, Apple Mail).
 */

const QUOTE_HEADER_PATTERNS: RegExp[] = [
  /^On .{3,200}(wrote|a écrit)\s*:?\s*$/i,           // Gmail/Apple (EN), sometimes FR clients with EN label
  /^Le .{3,200}a écrit\s*:?\s*$/i,                     // Gmail/Apple (FR)
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Message d'origine\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^-{2,}\s*Message transféré\s*-{2,}/i,
  /^_{10,}\s*$/,                                       // Outlook separator line
  /^(From|De)\s*:\s.+$/i,                              // Outlook header block start (checked with next lines)
  /^Begin forwarded message:/i,
];

const SIGNATURE_PATTERNS: RegExp[] = [
  /^-- ?$/,                                            // RFC 3676 sig delimiter
  /^Sent from my (iPhone|iPad|Android|mobile|Samsung|Galaxy|Pixel).*$/i,
  /^Envoyé de mon (iPhone|iPad|appareil|mobile).*$/i,
  /^Get Outlook for (iOS|Android).*$/i,
  /^Obtenir Outlook pour.*$/i,
  /^Sent from Mail for Windows.*$/i,
];

/** "On Tue, Mar 3, 2026 at 10:15 AM Jane <j@x.com>" sometimes wraps onto 2 lines; join them. */
function joinWrappedQuoteHeaders(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^(On|Le) .+/i.test(l) && !/(wrote|a écrit)\s*:?\s*$/i.test(l) && i + 1 < lines.length &&
        /(wrote|a écrit)\s*:?\s*$/i.test(lines[i + 1]) && l.length < 200) {
      out.push(l + " " + lines[i + 1].trim());
      i++;
    } else out.push(l);
  }
  return out;
}

export function stripQuotedText(text: string): string {
  const lines = joinWrappedQuoteHeaders(text.replace(/\r\n/g, "\n").split("\n"));
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (QUOTE_HEADER_PATTERNS.some((re) => re.test(t))) {
      // "From:" alone is only a quote header if followed by Sent/Date/To lines (Outlook block)
      if (/^(From|De)\s*:/i.test(t)) {
        const next = lines.slice(i + 1, i + 4).join("\n");
        if (!/^(Sent|Date|Envoyé|To|À|Subject|Objet)\s*:/im.test(next)) { kept.push(line); continue; }
      }
      break;
    }
    if (t.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripSignature(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (SIGNATURE_PATTERNS.some((re) => re.test(lines[i].trim()))) {
      // only treat as signature if it is in the last ~40% or last 12 lines
      if (i >= lines.length - 12 || i > lines.length * 0.6) return lines.slice(0, i).join("\n").trim();
    }
  }
  return text.trim();
}

/** What the model sees for a message: no quoted history, no signature, capped length. */
export function cleanForModel(text: string, maxChars = 12000): string {
  const cleaned = stripSignature(stripQuotedText(text));
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "\n[…message truncated…]" : cleaned;
}
