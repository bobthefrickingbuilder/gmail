# Testing

## Run everything

```bash
npm test
```

This runs the backend suite (Vitest, about 80 tests, in-memory SQLite plus mock Gmail/Calendar/Claude) and the web suite (Vitest + jsdom).

```bash
npm run typecheck
```

## What is covered

| Area | File |
|---|---|
| Gmail parsing: addresses, RFC 2047, charsets, HTML fallback, ICS invites, bad dates | `backend/test/parse.test.ts` |
| Quote & signature stripping (EN/FR, Gmail/Outlook/Apple) | `backend/test/parse.test.ts` |
| Reply MIME: Re: subject, In-Reply-To/References, reply vs reply-all | `backend/test/parse.test.ts` |
| Triage stage-1 rules, urgent keywords, deadlines | `backend/test/rules.test.ts` |
| Availability: DST, buffers, travel time, no-go windows, past times, title rule | `backend/test/availability.test.ts` |
| Prompt assembly order, hard rules, schedule privacy, tag neutralisation, thread trimming; post-checks | `backend/test/prompt.test.ts` |
| Profiles: sensitive filter, versions/revert, proposals, merge/split/delete | `backend/test/profiles.test.ts` |
| Auth: TOTP (RFC 6238 vector), tokens, refresh rotation and reuse detection, CORS/origin, headers | `backend/test/auth.test.ts` |
| **E2E** worker sync→triage→draft, idempotency, history expiry, budget cap, retry-once, dead letters; draft→redraft→edit→save→revert→send confirmation; discard; triage correction few-shots; calendar writes only on request; export/wipe | `backend/test/e2e.test.ts` |
| **Prompt-injection set**: no action, all flagged, tag break-out, worker cannot reach send (static) | `backend/test/injection.test.ts` |
| Seeding job (resumable), learning (proposal only), retention, push payload privacy, quiet hours, escalation rules, Anthropic provider (no tools, structured output, retry, refusal, fallback) | `backend/test/jobs.test.ts` |
| Eval checks (fabrication, disclosure, threading, signature…) | `backend/test/eval.test.ts` |
| Download page auth/escaping, version check, cron secret | `backend/test/download.test.ts` |
| **Chat**: tools run through the real services (archive, to-do, reply draft, labels, context email); history persisted and append-only; discard/junk/calendar/bulk wait for Confirm, Confirm runs once, Cancel; no send tool and no import path to `send.ts` (static); injected instructions in an email become proposals and taint the chat; system/AI labels refused; validation and rate limit | `backend/test/chat.test.ts` |
| Web: router, availability insertion, send dialog only sends after explicit tap | `web/test/ui.test.tsx` |

## Mock mode

`npm run mock` runs the whole app with fake Gmail, Calendar and Claude: no credentials, no network. Fixtures are in `backend/src/providers/mail/fixtures.ts` and include an injection attempt, French mail, an ICS invite, an ISO-8859-1 body and bulk/no-reply mail.

## Evaluation harness

```bash
npm run eval -- --mock
```

The mock run checks that the harness works.

```bash
npm run eval -- --limit 30
```

This uses your synced mail with real Haiku and Sonnet.

```bash
npm run eval -- --limit 30 --import 200
```

This first pulls 200 sent emails and the emails they answered from Gmail.

```bash
npm run eval -- --models haiku,sonnet,opus
```

This compares all three models.

The harness writes `eval-reports/<timestamp>/report.md` and `report.html` (git-ignored, because they contain email text): a summary per model (word overlap with what you actually sent, length ratio, cost, number of drafts failing each check, injection results) and every draft side by side with your real reply.

Checks: forbidden schedule disclosure, missing signature, extra sign-off, filler words, possible fabricated facts (money, times, dates or weekdays not found in the thread or availability), wrong threading (In-Reply-To, References, Re:, recipients), contractions in formal replies. The injection set checks that each model flags every hostile email and never claims to have carried out the hostile action.

Cost: about 2 × N drafts plus 12 injection drafts. With Haiku and Sonnet at 30 emails that's typically under $1. It's recorded in Usage under purpose "eval".

## Device test checklist

Run through this after each release.

### iPad (Safari PWA), iPadOS 16.4+
- [ ] Safari → Share → Add to Home Screen; icon and name look right; opens full-screen (no Safari bars); splash screen shows.
- [ ] Sign in with password and TOTP; add a passkey; lock (wait for idle time); unlock with Face ID / Touch ID.
- [ ] Landscape: three panes. Portrait: stacked. Rotate while a draft is open: text stays.
- [ ] Split View / Slide Over with Mail: layout adapts, nothing cut off.
- [ ] Settings → Notifications → enable → Allow; run `POST /api/mock/receive` (mock) or send yourself an urgent email; notification shows sender and subject only; tapping it opens the thread.
- [ ] Airplane mode: inbox and opened threads still readable, offline banner shows; edit a draft; back online, the edit syncs (check in Gmail Drafts).
- [ ] New server version deployed → "new version available" prompt → reload.
- [ ] Larger text (Settings → Accessibility → Display & Text Size): app text scales. VoiceOver: list rows, buttons and dialogs announce sensibly.
- [ ] Dark mode follows the system; Settings → Appearance override works.

### Android (current version and one older, e.g. 15 and 12)
- [ ] Download page asks for the password; download; "Install unknown apps" flow; app installs.
- [ ] First run: server address prefilled; sign in; push permission prompt (Android 13+); test notification arrives.
- [ ] Share text from another app → Email Assistant → "Draft from shared text" opens with the text.
- [ ] Long-press icon → "Drafts waiting" opens the filtered inbox.
- [ ] Swipe a row left (Done/Snooze/Skip) and right (Escalate); pull to refresh.
- [ ] Update: build v+1, the banner appears in the app, install over it, still signed in.
- [ ] TalkBack: navigation and draft panel usable. Font size at largest: no clipped buttons.
- [ ] Back button navigates within the app and doesn't exit unexpectedly.

### Server
- [ ] `docker compose up -d --build` → `/api/health` OK; logs show the setup code on first run only.
- [ ] Revoke the app at myaccount.google.com/permissions → within one poll, status shows "Reconnect needed" and a push arrives.
- [ ] Stop the network for 10 minutes → "stalled" push; recovers by itself.
- [ ] `./scripts/backup.sh` then `./scripts/restore.sh` round-trip on a copy.
