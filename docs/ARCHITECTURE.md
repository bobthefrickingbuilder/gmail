# Architecture

**Plain-language summary:** One small server (the *backend*) sits between your
phone/iPad and Google + Anthropic. It reads your mail, decides which emails need
a reply, asks Claude to write a draft in your voice, and puts that draft into
Gmail's Drafts folder. The apps on your devices only talk to this server. They
never hold the Google tokens or the Anthropic key. Nothing is ever sent unless you
tap **Send** and then confirm.

```
                 ┌────────────────────────── your devices ──────────────────────────┐
                 │  iPad (Safari → Add to Home Screen, PWA)   Android (Capacitor APK) │
                 │  Desktop browser   iPad app (Capacitor IPA)                        │
                 │            one shared React web app  (/web)                        │
                 └───────────────┬──────────────────────────────▲─────────────────────┘
                     HTTPS + Bearer session token                │ SSE (live updates)
                                 │                               │ Web Push / FCM (sender+subject only)
┌────────────────────────────────▼───────────────────────────────┴──────────────────────┐
│ BACKEND  (/backend, Node 22 + TypeScript + Fastify)                                     │
│                                                                                         │
│  HTTP API ── auth (password+TOTP, passkeys) ── rate limit ── strict CORS ── audit log   │
│     │                                                                                   │
│  Services:                                                                              │
│   • sync      Gmail incremental sync (historyId), full-sync fallback                    │
│   • parse     MIME → text/html/attachments, quote & signature stripping                 │
│   • triage    stage 1 rules (no model) → stage 2 Haiku classifier (+ few-shot fixes)    │
│   • profiles  per-correspondent profile, versions, merge/split, sensitive-data filter   │
│   • drafting  prompt assembly → Claude (text in, JSON out, NO tools) → validate → store │
│   • calendar  free/busy, find_availability(), scheduling-intent cards                   │
│   • learning  nightly edit-pattern summary → style-guide *proposals* (never auto-apply) │
│   • usage     tokens + cost per draft/day/month, budget cap pauses auto-drafting        │
│   • chat      in-app chat: Claude asks for tools that wrap the services above; no send, │
│               risky/bulk changes wait for your Confirm tap (chat/service.ts, tools.ts)  │
│                                                                                         │
│  Worker (same process, timer):  poll every 2 min → sync → triage → auto-draft           │
│     jobs: seed import (resumable), nightly learning, retention purge, health alerts     │
│                                                                                         │
│  Provider layer (interfaces, swappable):                                                │
│     MailProvider ── GoogleMail | MockMail        CalendarProvider ── GoogleCal | MockCal│
│     LlmProvider  ── Anthropic  | MockLlm                                                │
│                                                                                         │
│  Database (Kysely):  SQLite file (home server)  or  Postgres (Vercel/Neon)             │
│  Secrets: env vars; OAuth refresh tokens & TOTP secret AES-256-GCM encrypted in DB      │
└──────────────┬───────────────────────────────┬──────────────────────────────────────────┘
               │ OAuth 2.0 (minimal scopes)     │ HTTPS, API key
        ┌──────▼──────────────┐         ┌──────▼──────────┐
        │ Gmail + Calendar API │         │ Anthropic API   │
        └──────────────────────┘         └─────────────────┘
```

## Safety boundaries (the important part)

| Boundary | How it is enforced |
|---|---|
| No auto-send | The only code that calls Gmail *send* is `POST /api/drafts/:id/send`, which requires a fresh one-time confirmation token from `POST /api/drafts/:id/send/prepare`. The worker has no reference to the send function (`MailProvider.sendDraft` is only imported by the route). A unit test asserts the worker module never imports it. |
| Model cannot act (drafting, triage, worker) | Drafting and triage calls pass **no tools** (`LlmProvider.complete`). The model returns JSON; the backend stores it. Calendar writes, label changes and sends happen only from user taps. |
| In-app chat | The one place the model gets tools (`LlmProvider.chat`, only called from `chat/service.ts`, only when you type a message). Tools wrap existing services (`threads/service.ts`, `drafting/`, `compose/`, `tasks/`, `calendar/`). **There is no send tool**: a static test checks the chat code never imports `drafting/send.ts` or the draft routes. Reads and small reversible changes run at once; discarding drafts, junking/spamming a sender, calendar events and changes to more than 3 threads become a *proposal* (`chat_actions`) that runs only after your Confirm tap. Tool results containing email text go back inside `<untrusted>` markers (angle brackets neutralised); if any looks like instructions to an AI (`security/injection.ts`) the chat is marked *tainted* and **every** change from then on needs Confirm, so email text can never make a change by itself. Turns are rate-limited (20/min), every model call is in `usage` (`purpose = chat`), every change in `audit_log` (actor `chat`). |
| Secrets stay on server | API key + Google client secret are env vars; refresh tokens are encrypted in the DB. The web bundle is built without them; a test greps the build output. |
| Schedule privacy | The prompt only receives *free slots* (start/end), never event titles, locations or attendees, unless the user enables "share details" for that one draft. |
| Content privacy | Logs and audit entries store IDs, counts and statuses only. Push notifications carry sender + subject only. |

## Request flow: a new email arrives

1. Worker polls (`users.history.list` from the stored `historyId`; full sync if it expired).
2. Each new message is parsed and stored (idempotent on `(account_id, provider_message_id)`).
3. Triage stage 1 (rules): List-Unsubscribe, no-reply senders, bulk precedence, your own address, sender rules → `AI/Skipped`.
4. Triage stage 2 (Haiku): category, priority 0–100, one-line summary, reasoning, urgent flag.
5. If the category is draft-enabled and the monthly budget is not exhausted, the drafting pipeline runs:
   system rules → style guide → profile + pinned docs → thread (trimmed) → availability (only if scheduling) → instruction → past-reply examples.
6. Draft JSON validated (retry once). Draft written to Gmail (create or **update** existing draft), labels applied (`AI/Drafted`, `AI/Needs-Review`, `AI/Escalated`).
7. Profile update proposal stored (auto-applied or waiting for approval, per setting).
8. SSE event → app refreshes; urgent → push notification.

## File layout

```
/backend      Fastify API + worker + providers + tests + eval harness
/web          React PWA (shared UI for iPad, Android, desktop)
/android      Capacitor project + signed-APK build script
/ios          Capacitor iOS project (SPM); unsigned IPA built by .github/workflows/ios.yml, sideloaded (docs/IOS.md)
/config       models.json, style-guide.md, triage-rules.json, signature.json
/profiles     (unused: profiles live in the DB; folder holds exports)
/docs         INSTALL, DECISIONS, ARCHITECTURE, SECURITY, TESTING, DATA-MODEL, ...
/scripts      setup, backup/restore, release, secrets scan hook
```

See `DATA-MODEL.md` for the tables.

## Request flow: a chat message

1. `POST /api/chat/:id/messages {text}` (Chat tab, or "✦ Ask Claude" on an email, which starts a chat about that thread).
2. The message is stored (`chat_messages`), plus an `<app_note>` with the outcome of any Confirm/Cancel taps since the last turn.
3. Loop (at most 10 steps): `LlmProvider.chat` with the system rules, the stored history (append-only, sent back unchanged) and the tool list → usage recorded → for each tool the model asks for, `chat/tools.ts` validates the input and either runs it through the service, proposes it (Confirm card), or refuses it → results stored.
4. Each step is streamed back as NDJSON (`text`, `activity`, `done`), so "Archived 3 emails" lines appear as they happen.
5. `POST /api/chat/actions/:id/confirm` runs a proposal exactly as stored, once (claimed atomically); `…/cancel` drops it.
