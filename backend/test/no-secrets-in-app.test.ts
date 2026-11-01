/** Hard constraint #2: the apps never contain the Anthropic key or Google OAuth secrets. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const FORBIDDEN = [/ANTHROPIC_API_KEY/, /GOOGLE_CLIENT_SECRET/, /ENCRYPTION_KEY/, /SESSION_SECRET/, /sk-ant-[A-Za-z0-9]/, /GOCSPX-/, /@anthropic-ai\/sdk/, /googleapis/];

describe("client code contains no secrets or server-only SDKs", () => {
  it("web source and built bundle", () => {
    const targets = [...files(path.join(root, "web", "src")), ...files(path.join(root, "web", "dist")).filter((f) => /\.(js|html|webmanifest)$/.test(f))];
    expect(targets.length).toBeGreaterThan(10);
    for (const f of targets) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of FORBIDDEN) expect(re.test(text), `${path.relative(root, f)} matches ${re}`).toBe(false);
    }
  });
});
