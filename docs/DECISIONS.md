# Decisions

Format: **decision** — why. "Decided" items come from the build brief; "Chosen"
items were open in the brief and this is the simplest option that meets the
requirement.

## Decided by the brief
- **Drafts only, never auto-send.** Send exists only as a user tap plus a confirmation step.
- **Secrets only on the backend.** Apps authenticate to the backend and nothing else.
- **Android = signed APK (Capacitor), iPad = PWA (Add to Home Screen).** No IPA/TestFlight.
- **Models:** Haiku drafts by default, escalate to Sonnet, then Opus. IDs live only in `config/models.json`.
- **Single user**, one Google account, data model ready for more accounts/aliases.

## Chosen
| # | Topic | Choice | Why |
|---|---|---|---|
| 1 | Backend language | **Node 22 + TypeScript** | Same language as the web app; one toolchain. |
| 2 | HTTP framework | **Fastify 5** | Small, fast, good plugins for CORS, helmet, rate limit. |
| 3 | Database layer | **Kysely** query builder + its migrator | Same queries run on SQLite and Postgres; switch with `DATABASE_URL`. |
| 4 | Default DB / hosting | **SQLite on the home server via Docker Compose** | Least infrastructure: one container, one file, easy backup. Vercel + Neon is documented in INSTALL.md as the alternative but is not the primary target (Vercel functions cannot hold a 2-minute polling loop; it needs Vercel Cron, see INSTALL). |
| 5 | Worker | **In-process timer** in the same Node process | No queue service to run. Jobs are idempotent and tracked in the DB, so restarts are safe. |
| 6 | Gmail push (Pub/Sub) | **Not enabled in v1**; polling only | Polling is the required baseline; Pub/Sub needs a public webhook and a GCP topic. Hook point: `POST /api/webhooks/gmail` (stubbed, documented). |
| 7 | Web framework | **React 19 + Vite** | Most widely documented; `vite-plugin-pwa` makes the PWA/service worker. |
| 8 | Routing in the web app | Small built-in router (hash routes) | Works identically inside Capacitor (`file://`-like origin) and Safari PWA. |
| 9 | Realtime | **Server-sent events** (`/api/events`) | One-way server→app is all we need; simpler than WebSocket. Pull-to-refresh as fallback. |
| 10 | App auth tokens | **Bearer tokens** (15-min access, 30-day rotating refresh) in memory + IndexedDB | Works the same in Capacitor and Safari (cookies across origins are unreliable in Capacitor). Because no cookies are used for auth, classic CSRF does not apply; we still require `Origin` to match the allow-list on state-changing requests. |
| 11 | Login | **Password + TOTP**, plus optional **passkey** (WebAuthn) for biometric unlock | Passkeys give Face ID / Touch ID / Android biometrics in browsers that support it; password+TOTP is the fallback. |
| 12 | Password hashing | Node `crypto.scrypt` | Built-in, no native module. |
| 13 | Encryption at rest | AES-256-GCM, key from `ENCRYPTION_KEY` | Standard, built-in. |
| 14 | Structured output | Anthropic **structured outputs** (`output_config.format` JSON schema) + our own Zod validation, retry once | Belt and braces: schema-constrained output, still validated. |
| 15 | Refusal handling | Sonnet/Opus calls opt into the API's **server-side fallback** (`fallbacks: "default"`); a `refusal` stop reason is recorded as a flag and the email is left undrafted | Recommended default for these models; toggle per model in `models.json` (`serverFallback`). |
| 16 | Effort | Per-model `effort` in `models.json` (Haiku `low` for triage, `medium` for drafts) | Effort is the cost/quality knob on current models; sampling params (temperature) are not used. |
| 17 | Profiles storage | **Database**, not files | Version history, merge and wipe are simpler in SQL. `/profiles` only receives exports. |
| 18 | Retrieval of past replies | Simple scoring (same person first, then same category + keyword overlap) | No vector DB needed for one user's mail volume. |
| 19 | Push | **Web Push (VAPID)** for the iPad PWA and desktop; **FCM HTTP v1** for Android (optional, needs a Firebase project) | Matches each platform; both optional, configured by env vars. |
| 20 | Attachment text | `pdf-parse` (PDF) and `mammoth` (DOCX), 5 MB cap, 20k chars cap | Pure JS, no system packages. |
| 21 | Signature | Fetched from Gmail send-as settings; fallback template in `config/signature.json`; groups selectable per person | As specified. |
| 22 | Reply vs reply-all | Default **reply-all when the original had other human recipients in To/Cc and you were in To**, else reply; changeable per draft | Simple, predictable rule. |
| 23 | Costs | Prices in `models.json` (USD per million tokens) | Update the file when prices change; no code change. |
| 24 | Versioning | SemVer in root `package.json`, `CHANGELOG.md`, git tags `vX.Y.Z` | Standard. |
| 25 | Calendar view | Agenda + week list inside the app, Google Calendar is the source of truth | As specified for v1. |
| 26 | Offline | Service worker caches the shell; app caches recent threads/drafts in IndexedDB; edits queue in IndexedDB | Works in Safari PWA and Capacitor. |
| 27 | Android widget / quick actions | Android **app shortcut** ("Drafts waiting") + share target via Capacitor intent filter; a home-screen *widget* is listed in ASSETS-NEEDED/roadmap | A native widget needs Kotlin code outside Capacitor; the shortcut covers the use case in v1. |
| 28 | Eval harness | CLI script producing a Markdown + HTML side-by-side report | No extra service. Runs in mock mode with fixtures, or against real mail. |
| 29 | Time zone | `America/Toronto` default, setting in app | Ottawa. |
| 30 | Google scopes | `gmail.modify`, `calendar.readonly`, `calendar.events` (+ `openid email`) | `gmail.modify` already covers reading, drafts, labels and sending a draft, so separate `gmail.readonly`/`compose`/`send`/`labels` scopes would add nothing. Sending is still only reachable from the confirmed Send route. |
| 31 | Draft editor | Plain-text editor; the email goes out as text plus a simple HTML version (paragraphs + your Gmail HTML signature) | Rich-text editing (bold, links) adds a lot of complexity for little benefit in replies. Can be added later without changing the backend. |
| 32 | Retention | Purge bodies of all mail after N days, but keep the cleaned text of *your own* sent replies | Those are your words and power the "voice examples"; other people's content is removed. |
| 33 | Contacts import | Not in v1; profile seeding uses your sent mail only | The Contacts API needs another Google scope; sent mail already finds the people you write to. |
| 34 | Older thread messages | Summarised deterministically (date, sender, first ~200 characters) when the thread exceeds the budget | No extra model call or cost; the newest messages are always included in full. |
| 35 | Thread state after you reply | A thread whose latest message is yours moves to "Done"; a new incoming message re-opens it | Keeps the inbox to things waiting on you. |
| 36 | First-run security | One-time setup code printed in the server log (or `SETUP_CODE`) | Stops someone who finds the URL first from claiming the account. |
| 37 | Placeholders block sending | A draft containing `[CONFIRM: …]` cannot be sent | Prevents sending a draft with unresolved facts. |
| 38 | Model JSON | Structured outputs plus `effort` per model; no `temperature` | Current models reject sampling parameters; effort is the supported knob. |
| 39 | Android widget | App shortcut ("Drafts waiting") + share target; no home-screen widget in v1 | A widget needs native Kotlin UI; listed for later. |
| 40 | Verification limits in this build environment | APK build and Docker image build scripted but **not executed here** (no Android SDK download / no Docker daemon in the build sandbox); the production Node build was run and verified | Honest status; see TESTING.md device checklist. |
| 41 | SQLite driver version | `better-sqlite3` pinned to `^12.11.1` instead of `^13.0.3`; its install script is allowed in root `package.json` (`allowScripts`) | 13.x ships no prebuilt binaries and must compile from source, which needs Visual Studio C++ build tools on Windows. 12.11.1 downloads a prebuilt binary for Node 20–26. All 78 backend tests pass with it on Windows / Node 24. |
