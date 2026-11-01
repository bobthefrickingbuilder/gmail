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
                 │  Desktop browser (testing)                                         │
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
| Model cannot act | Drafting and triage calls pass **no tools**. The model returns JSON; the backend stores it. Calendar writes, label changes and sends happen only from user taps. |
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
/config       models.json, style-guide.md, triage-rules.json, signature.json
/profiles     (unused: profiles live in the DB; folder holds exports)
/docs         INSTALL, DECISIONS, ARCHITECTURE, SECURITY, TESTING, DATA-MODEL, ...
/scripts      setup, backup/restore, release, secrets scan hook
```

See `DATA-MODEL.md` for the tables.
