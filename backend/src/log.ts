/**
 * LOGGING
 * Structured JSON logs (pino). Rule: never log email bodies, subjects of
 * other people's mail, tokens or keys. Log IDs, counts and statuses.
 * The redact list below is a safety net in case a field slips through.
 */
import pino from "pino";
import { env } from "./config.js";

export const log = pino({
  level: env().NODE_ENV === "test" ? "silent" : env().LOG_LEVEL,
  redact: {
    paths: ["*.body", "*.body_text", "*.body_html", "*.stripped_text", "*.draft_body", "*.content",
      "*.access_token", "*.refresh_token", "*.tokens", "*.password", "*.apiKey", "*.authorization",
      "req.headers.authorization", "req.headers.cookie"],
    censor: "[redacted]",
  },
});
