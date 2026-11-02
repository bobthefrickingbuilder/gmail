# Install guide

This guide sets everything up in order: try it with fake data, create the Google project, run the server at home, install the iPad and Android apps, and keep it backed up.

> Plain-language summary: one server holds your Google and Anthropic keys. The iPad "app" is the website saved to your Home Screen. The Android app is a file you download and install yourself. Both apps only talk to your server.

---

## 0. Requirements

- A computer that stays on: a home server, NAS, Mac mini or Linux box. Docker is easiest; Node.js 22+ also works.
- A way to reach it over **HTTPS** from your iPad and phone (section 3).
- A Google account (the one with your Gmail and Calendar).
- An Anthropic API key (console.anthropic.com → API Keys).

## 1. Try it first with fake data (5 minutes, no keys)

```bash
git clone <this repo> gmail && cd gmail
```

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run mock
```

Open http://localhost:8787. The terminal prints a line like `FIRST-RUN SETUP CODE: 123456789012`. Enter that code and choose a password of 12 or more characters. You'll see a fictional inbox with drafts. Nothing leaves your machine in mock mode. In mock mode, **Settings → Status → Check mail now** or `POST /api/mock/receive` simulates a new email.

Stop it with Ctrl-C. Delete `backend/data/` if you want to start fresh.

## 2. Google Cloud project (one time, about 15 minutes)

1. Go to https://console.cloud.google.com/ and sign in with **the Gmail account the assistant will manage**.
2. **Create a project:** project picker (top bar) → *New project* → name it `Email Assistant` → *Create*. Make sure it's selected.
3. **Enable the APIs:** *APIs & Services → Library*, then search for and **Enable** each of these:
   - Gmail API
   - Google Calendar API
4. **OAuth consent screen:** *APIs & Services → OAuth consent screen* (in newer consoles, *Google Auth Platform → Branding*).
   - User type: **External** → *Create*.
   - App name `Email Assistant`, your email as support and developer contact → *Save and continue*.
   - **Scopes:** *Add or remove scopes*, then add exactly these:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/calendar.events`
     - `openid`, `.../auth/userinfo.email`
   - **Test users:** add your own Gmail address (the only user).
   - Leave the app in **Testing**. Don't publish it. In Testing mode, Google may expire the refresh token after 7 days. If that happens, the app shows "Reconnect Google" and sends you a notification; one tap fixes it. To avoid it, you can submit the app for verification. For a single private user, reconnecting occasionally is the simpler choice.
5. **Credentials:** *APIs & Services → Credentials → Create credentials → OAuth client ID*.
   - Application type: **Web application**.
   - Authorized redirect URI: `https://YOUR-DOMAIN/api/google/callback`. Use exactly the `PUBLIC_URL` from `.env` plus `/api/google/callback`. For local testing also add `http://localhost:8787/api/google/callback`.
   - *Create*, then copy the **Client ID** and **Client secret** into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Put your Anthropic key in `.env` as `ANTHROPIC_API_KEY`.

Why these scopes (see DECISIONS.md #30): `gmail.modify` reads mail, writes drafts and labels, and covers sending a draft (used only by the confirmed Send button). `calendar.readonly` provides free/busy. `calendar.events` creates the tentative events you ask for. Nothing else is requested.

## 3. Run the server

### Option A (recommended): home server with Docker

1. Edit `.env` (created by `npm run setup`). Set at least `PUBLIC_URL`, `APP_ORIGINS`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and set `MOCK_MODE=false`.
2. Start it:

```bash
docker compose up -d --build
```

```bash
docker compose logs assistant | grep "SETUP CODE"
```

3. **HTTPS.** Pick one of these:
   - **Cloudflare Tunnel** (no open ports): install `cloudflared`, create a tunnel to `http://localhost:8787`, and use the hostname it gives you as `PUBLIC_URL`.
   - **Tailscale Funnel**: `tailscale funnel 8787`, then use the `https://<machine>.<tailnet>.ts.net` URL. Tailscale Serve keeps it private to your own devices, which also works.
   - **Caddy with your own domain:** point a DNS A record at your home IP, forward ports 80 and 443, add `DOMAIN=mail.yourdomain.ca` to `.env`, then run:

```bash
docker compose --profile https up -d
```

4. Open `PUBLIC_URL` in a browser, enter the setup code, choose a password, then go to **Settings → Accounts → Connect Google**.
5. Go to **Settings → Security** and set up an authenticator code (TOTP). On iPad, also add a passkey for Face ID / Touch ID.

Without Docker, the same thing as a plain Node service:

```bash
npm ci && npm run build && node backend/dist/index.js
```

Run it under systemd or pm2 so it restarts automatically.

**On Windows:** a Task Scheduler task named `Email Assistant` runs `wscript.exe scripts\windows-start.vbs` at sign-in (no console window, restart on failure, output in `data\server.log`). Set `HOST=127.0.0.1` in `.env` and put Tailscale Serve in front (`tailscale serve --bg 8787`). Ending the task does not stop node, so use `scripts\windows-restart.cmd` instead: no argument restarts, `build` rebuilds first, `stop` stops it.

### Option B: Vercel + Neon Postgres (documented alternative)

Serverless hosting has no always-on worker. Polling is done by Vercel Cron calling `/api/cron/poll`. On the Hobby plan crons run at most once a day; Pro is needed for every 5 minutes.

1. Create a Neon Postgres database and copy its connection string.
2. Import the repo into Vercel. `vercel.json` already sets the build, rewrites and cron.
3. In Vercel → Settings → Environment Variables, add everything from `.env.example`, with `DATABASE_URL=postgres://…` and a `CRON_SECRET`.
4. Live updates (SSE) are unreliable on serverless, so the app falls back to pull-to-refresh. The APK download page needs file storage, so host the APK elsewhere or use Option A.

## 4. iPad: install the app (PWA)

iPadOS doesn't allow installing native apps from a download outside the App Store. The supported equivalent is a Home Screen web app, which runs full-screen with its own icon.

1. On the iPad, open **Safari** (it must be Safari) and go to your `PUBLIC_URL`.
2. Tap the **Share** button (square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open **Email Assistant** from the Home Screen. Don't use the Safari tab.
4. Sign in. In **Settings → Security**, tap **Add a passkey on this device** so Face ID / Touch ID unlocks the app.
5. **Notifications:** inside the installed app, tap **Settings → Notifications → Enable notifications on this device**, then **Allow**. This needs iPadOS 16.4 or later and only works from the Home Screen app, not a Safari tab. Notifications show only the sender and subject.
6. Updating: nothing to do. When a new version is deployed, the app asks "A new version is available. Reload now?"

Landscape shows three panes (list, email, draft). Portrait shows one screen at a time. Split View and Slide Over work as with any Home Screen app.

## 5. Android: build, host and install the APK

### Build (on your computer, once per release)

1. Install **Android Studio** (it includes the SDK) and **Java 21**. Set `ANDROID_HOME` (macOS: `~/Library/Android/sdk`).
2. Create the signing key, one time only:

```bash
./scripts/make-keystore.sh
```

This writes `android/keystore/release.jks` and `android/keystore.properties`, both git-ignored. **Back up both, and the password, in your password manager.** If you lose them you can't publish updates that install over the existing app; you'd have to uninstall and reinstall.
3. Optional, for Android notifications: create a Firebase project, add an Android app with package `ca.matthewmenard.assistant`, and download `google-services.json` into `android/app/` (git-ignored). Then put a Firebase service-account key in `.env` as `FCM_SERVICE_ACCOUNT_JSON` (one line).
4. Build:

```bash
API_BASE=https://YOUR-DOMAIN RELEASES_DIR=./data/releases ./scripts/build-apk.sh
```

This builds the web app for your server, syncs it into the Android project, builds and verifies a **signed release APK**, copies it to the releases folder, and adds an entry (with the CHANGELOG line) to `releases.json`. On Docker, the releases folder is `./data/releases` (the `/data` volume).

### Host

Set `DOWNLOAD_PASSWORD` in `.env`. `npm run setup` generates one. Restart the server. The private download page is `https://YOUR-DOMAIN/download` (any username, that password). It shows the version and the changelog.

### Install on the phone

1. On the Android phone, open the download page in Chrome and enter the password.
2. Tap **Download vX.Y.Z**, then open the downloaded file.
3. The first time, Android says installs from Chrome aren't allowed. Tap **Settings**, turn on **Allow from this source** ("Install unknown apps" for Chrome), go back, and tap **Install**.
4. Open **Email Assistant**. If asked, enter the server address (built in from `API_BASE`), then sign in.
5. Long-press the app icon for the **Drafts waiting** shortcut. In any app, **Share → Email Assistant** sends text in to draft a reply.

### Update

The app checks `/api/app/version` and shows a banner when a newer APK exists. Tap **Download** and install over the old one. Data is kept because the signing key is the same.

## 6. Onboarding inside the app

**Settings → Setup** walks through: connect Google, import history (scans N months of sent mail and seeds profiles; resumable), review the style guide, enable notifications, run a test draft.

## 7. Backup and restore

```bash
./scripts/backup.sh
```

This writes `backups/<timestamp>.tar.gz` (database snapshot plus `/config`) and keeps the 30 newest. Schedule it nightly, for example with cron: `15 3 * * * cd /path/to/gmail && ./scripts/backup.sh`. Copy backups off the machine. The Google tokens inside are encrypted, so keep `.env` (in particular `ENCRYPTION_KEY`) backed up separately, in your password manager.

To restore, stop the server, then run:

```bash
docker compose stop assistant
```

```bash
./scripts/restore.sh backups/20261101-031500.tar.gz
```

```bash
docker compose start assistant
```

The app also has **Settings → Budget & data → Export all data** (JSON, no tokens) and **Wipe all data**.

## 8. Versioning, releases and rollback

- Versions follow `MAJOR.MINOR.PATCH` in the root `package.json`, shared by server, web and APK. Record changes in `CHANGELOG.md`.
- Release: bump the version, update CHANGELOG, commit, `git tag vX.Y.Z`, then `docker compose up -d --build` (server and PWA) and `./scripts/build-apk.sh` (Android).
- **Roll back the server/PWA:** `git checkout vPREVIOUS && docker compose up -d --build`. Database migrations only ever add things, so an older server still runs against a newer database. Restore a backup if a release changed data in a way you want to undo.
- **Roll back Android:** Android won't install a lower version over a higher one. Rebuild the previous tag with a *higher* patch number (for example re-release 0.3.0's code as 0.3.2), or uninstall and reinstall the older APK. The server keeps your data, not the phone.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Reconnect Google" banner / push | Settings → Accounts → Connect Google (Testing-mode tokens expire after ~7 days). |
| No new mail | Settings → Status: check "last successful poll" and errors. `docker compose logs assistant`. |
| iPad: no notification option | Use the Home Screen app, not Safari; iPadOS 16.4+. |
| Android: "App not installed" | The update was signed with a different key. Use your saved keystore. |
| Drafts stopped appearing | Monthly budget reached (Settings → Budget), or auto-drafting turned off. Manual Draft still works. |
