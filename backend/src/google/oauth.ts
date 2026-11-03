/**
 * GOOGLE SIGN-IN (OAuth 2.0)
 * --------------------------
 * Flow: the app opens /api/google/connect → Google consent screen → Google
 * redirects to /api/google/callback with a code → we swap it for tokens and
 * store the refresh token ENCRYPTED in the accounts table.
 *
 * Scopes (minimal, see DECISIONS.md #30):
 *   gmail.modify      read mail, create/update drafts, apply labels, send a draft
 *                     (send is only ever used by the confirmed Send button)
 *   calendar.readonly list calendars, free/busy, read events
 *   calendar.events   create the tentative events you ask for
 *   contacts.readonly, contacts.other.readonly
 *                     your Google contacts, for address autocomplete when you write
 *                     an email (read only; see DECISIONS.md #47)
 */
import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import { env } from "../config.js";
import { decrypt, encrypt } from "../crypto.js";
import { getDb, now } from "../db/index.js";
import { AuthExpiredError } from "../providers/mail/types.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "openid",
  "email",
];

export function redirectUri() { return `${env().PUBLIC_URL.replace(/\/$/, "")}/api/google/callback`; }

export function makeOAuthClient(): OAuth2Client {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri());
}

export function consentUrl(state: string): string {
  return makeOAuthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES, state, include_granted_scopes: true });
}

export async function exchangeCode(code: string): Promise<{ email: string; tokens: Credentials }> {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const info = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
  if (!info.data.email) throw new Error("Google did not return an email address");
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.");
  return { email: info.data.email.toLowerCase(), tokens };
}

/** An authorized client for an account; persists refreshed tokens automatically. */
export async function authorizedClient(accountId: string): Promise<OAuth2Client> {
  const db = await getDb();
  const acc = await db.selectFrom("accounts").select(["tokens_enc", "status"]).where("id", "=", accountId).executeTakeFirstOrThrow();
  if (!acc.tokens_enc) throw new AuthExpiredError("Google is not connected");
  const client = makeOAuthClient();
  const saved = JSON.parse(decrypt(acc.tokens_enc)) as Credentials;
  client.setCredentials(saved);
  client.on("tokens", async (t) => {
    const merged = { ...saved, ...t, refresh_token: t.refresh_token ?? saved.refresh_token };
    await db.updateTable("accounts").set({ tokens_enc: encrypt(JSON.stringify(merged)), status: "ok" }).where("id", "=", accountId).execute();
  });
  return client;
}

export const encryptTokens = (t: Credentials) => encrypt(JSON.stringify(t));

/** Turn Google's "invalid_grant" into our AuthExpiredError and flag the account. */
export async function markReauth(accountId: string, message: string) {
  const db = await getDb();
  await db.updateTable("accounts").set({ status: "reauth_required", last_error: message.slice(0, 300), last_sync_at: now() })
    .where("id", "=", accountId).execute();
}

export function isAuthError(e: unknown): boolean {
  const err = e as { message?: string; response?: { status?: number; data?: { error?: string } }; code?: number | string };
  const msg = String(err?.message ?? "");
  return /invalid_grant|invalid_token|Token has been expired or revoked|unauthorized_client/i.test(msg) ||
    err?.response?.data?.error === "invalid_grant" || err?.response?.status === 401 || err?.code === 401;
}
