# Email Assistant

A private email assistant for one person. It reads incoming Gmail, decides what needs a reply, keeps a short profile of each correspondent, checks your Google Calendar for real availability, and writes reply drafts in your voice with Claude. Drafts land in **Gmail Drafts** for you to review. **It never sends email on its own:** sending needs a tap, then a confirmation dialog.

- **iPad:** Home Screen web app (Safari → Share → Add to Home Screen)
- **Android:** signed APK from your private download page
- **Desktop:** any browser

All three use the same interface and talk only to your own server, which holds the Google and Anthropic keys.

## Quick start (fake data, no keys)

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run mock
```

Open http://localhost:8787 and enter the setup code printed in the terminal.

For real mail, follow **[docs/INSTALL.md](docs/INSTALL.md)**.

## How it works (one paragraph)

Every 2 minutes the server asks Gmail what's new. Each email goes through **rules** (newsletters, no-reply and bulk mail are skipped for free), then a quick **Haiku** classification (needs reply, scheduling, urgent…). For reply-worthy mail, it gathers the thread, the person's profile, your style guide, a few of your past replies, and (only for scheduling) your free time slots. It asks Claude for a draft as structured JSON, checks it (no fabricated facts, no leaking your schedule, no extra sign-off), and saves it as a Gmail draft in the right thread. The app shows the draft with its confidence, open questions and flags. You edit, redraft with Sonnet or Opus, save, or send.

## Repository layout

| Folder | What's inside |
|---|---|
| `backend/` | Node + TypeScript server: API, background worker, Gmail/Calendar/Claude providers, tests, eval harness |
| `web/` | React app (PWA): the shared UI for iPad, Android and desktop |
| `android/` | Capacitor Android project (wraps `web/`) |
| `config/` | `models.json`, `style-guide.md`, `triage-rules.json`, `signature.json`. Editable, no code changes needed |
| `docs/` | [INSTALL](docs/INSTALL.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [DECISIONS](docs/DECISIONS.md) · [DATA-MODEL](docs/DATA-MODEL.md) · [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) |
| `scripts/` | Setup, APK build, keystore, backup/restore, secrets-scan hook |

## Everyday commands

| Command | Does |
|---|---|
| `npm run mock` | Run everything with fake Gmail, Calendar and Claude |
| `npm run dev` / `npm run dev:web` | Backend / web app with auto-reload |
| `npm test` | All tests |
| `npm run eval -- --limit 30` | Compare Haiku vs Sonnet drafts with what you actually sent |
| `./scripts/backup.sh` | Back up the database and config |
| `API_BASE=https://… ./scripts/build-apk.sh` | Build and publish the signed Android APK |

## Status

See [CHANGELOG.md](CHANGELOG.md). Items not verified in the build environment are listed in docs/DECISIONS.md #40 and the device checklist in docs/TESTING.md. Placeholder artwork is listed in [ASSETS-NEEDED.md](ASSETS-NEEDED.md).
