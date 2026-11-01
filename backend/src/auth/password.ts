/** PASSWORD HASHING — Node's built-in scrypt with a random salt; constant-time compare. */
import crypto from "node:crypto";

const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, rr, pp, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(rr), p: Number(pp) });
  return crypto.timingSafeEqual(expected, got);
}

export function passwordProblems(pw: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters";
  if (/^(.)\1+$/.test(pw)) return "Too repetitive";
  return null;
}
