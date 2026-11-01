/**
 * SIGNATURE
 * Uses your Gmail "send-as" signature (fetched from Gmail settings) when it
 * exists; otherwise a template from config/signature.json. The signature can
 * be chosen per person (signature group) and changed per draft.
 * Keys: "gmail" = Gmail signature; any other key = a group in signature.json.
 */
import { getSignatureConfig } from "../settings.js";
import type { SendAs } from "../providers/mail/types.js";

export interface ResolvedSignature { key: string; text: string | null; html: string | null }

export async function resolveSignature(key: string | null, fromEmail: string, sendAs: SendAs[]): Promise<ResolvedSignature> {
  const cfg = await getSignatureConfig();
  const gmail = sendAs.find((s) => s.email === fromEmail.toLowerCase())?.signature ?? sendAs.find((s) => s.isPrimary)?.signature ?? null;
  const chosen = key ?? (cfg.prefer_gmail_signature && gmail ? "gmail" : cfg.default);
  if (chosen === "gmail" && gmail) return { key: "gmail", text: null, html: gmail };
  const group = cfg.groups[chosen] ?? cfg.groups[cfg.default];
  return { key: cfg.groups[chosen] ? chosen : cfg.default, text: group?.text ?? null, html: null };
}

export async function signatureOptions(sendAs: SendAs[]) {
  const cfg = await getSignatureConfig();
  return [
    ...(sendAs.some((s) => s.signature) ? [{ key: "gmail", label: "Gmail signature" }] : []),
    ...Object.entries(cfg.groups).map(([key, g]) => ({ key, label: g.label })),
  ];
}
