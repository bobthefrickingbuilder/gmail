/**
 * PASSKEYS (WebAuthn) — Face ID / Touch ID on iPad, fingerprint/face on
 * Android browsers that support it. Register a passkey after logging in
 * with password + code; afterwards it can unlock the app on its own.
 */
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, AuthenticatorTransport } from "@simplewebauthn/server";
import { env } from "../config.js";
import { getDb, now, uid } from "../db/index.js";

const challenges = new Map<string, { challenge: string; exp: number }>();
const rp = () => { const u = new URL(env().PUBLIC_URL); return { rpID: u.hostname, origins: [u.origin, ...env().APP_ORIGINS.split(",").map((s) => s.trim()).filter((o) => o.startsWith("https://") || o.startsWith("http://localhost"))] }; };

export async function registrationOptions() {
  const db = await getDb();
  const creds = await db.selectFrom("webauthn_credentials").selectAll().execute();
  const opts = await generateRegistrationOptions({
    rpName: "Email Assistant", rpID: rp().rpID, userName: "owner", userDisplayName: "Owner",
    attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined })),
  });
  challenges.set("reg", { challenge: opts.challenge, exp: Date.now() + 5 * 60000 });
  return opts;
}

export async function verifyRegistration(response: RegistrationResponseJSON, label: string | null) {
  const c = challenges.get("reg");
  if (!c || c.exp < Date.now()) throw new Error("Registration expired; try again");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp().origins, expectedRPID: rp().rpID, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) throw new Error("Passkey not verified");
  const { credential } = v.registrationInfo;
  const db = await getDb();
  await db.insertInto("webauthn_credentials").values({ id: uid(), credential_id: credential.id, public_key: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter, transports: credential.transports ? JSON.stringify(credential.transports) : null, label, created_at: now() }).execute();
  challenges.delete("reg");
  return true;
}

export async function authenticationOptions() {
  const db = await getDb();
  const creds = await db.selectFrom("webauthn_credentials").selectAll().execute();
  const opts = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: "required",
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })) });
  challenges.set("auth", { challenge: opts.challenge, exp: Date.now() + 5 * 60000 });
  return opts;
}

export async function verifyAuthentication(response: AuthenticationResponseJSON) {
  const c = challenges.get("auth");
  if (!c || c.exp < Date.now()) throw new Error("Sign-in expired; try again");
  const db = await getDb();
  const cred = await db.selectFrom("webauthn_credentials").selectAll().where("credential_id", "=", response.id).executeTakeFirst();
  if (!cred) throw new Error("Unknown passkey");
  const v = await verifyAuthenticationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp().origins, expectedRPID: rp().rpID,
    credential: { id: cred.credential_id, publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64")), counter: cred.counter }, requireUserVerification: true });
  if (!v.verified) throw new Error("Passkey not verified");
  await db.updateTable("webauthn_credentials").set({ counter: v.authenticationInfo.newCounter }).where("id", "=", cred.id).execute();
  challenges.delete("auth");
  return true;
}
