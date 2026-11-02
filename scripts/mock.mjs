/**
 * MOCK MODE:  npm run mock
 * Starts the backend with fake Gmail, Calendar and Claude (MOCK_MODE=true).
 * A script instead of `MOCK_MODE=true npm run …` so it also works on Windows,
 * where npm runs scripts through cmd.exe.
 */
import { spawn } from "node:child_process";

const child = spawn("npm", ["run", "dev", "-w", "backend"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, MOCK_MODE: "true" },
});
child.on("exit", (code) => process.exit(code ?? 0));
