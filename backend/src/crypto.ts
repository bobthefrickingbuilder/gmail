/**
 * ENCRYPTION AT REST
 * Google refresh tokens and the TOTP secret are stored encrypted with
 * AES-256-GCM. The key comes from the ENCRYPTION_KEY env var (32 random bytes,
 * base64). Lose the key → you must reconnect Google and re-enrol TOTP; nothing
 * else is lost. In mock/test mode a fixed development key is used.
 */
import crypto from "node:crypto";
import { env } from "./config.js";

const DEV_KEY = Buffer.alloc(32, 7); // only used when MOCK_MODE or NODE_ENV=test

function key(): Buffer {
  const k = env().ENCRYPTION_KEY;
  if (k) {
    const buf = Buffer.from(k, "base64");
    if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return buf;
  }
  if (env().MOCK_MODE || env().NODE_ENV === "test") return DEV_KEY;
  throw new Error("ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32");
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(token: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export function sessionSecret(): Buffer {
  const s = env().SESSION_SECRET;
  if (s) return Buffer.from(s);
  if (env().MOCK_MODE || env().NODE_ENV === "test") return Buffer.from("dev-session-secret-not-for-production");
  throw new Error("SESSION_SECRET is not set. Generate one with: openssl rand -base64 48");
}
