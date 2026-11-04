# iPad app (sideloaded)

A real app icon for your iPad (iPadOS 14 or later, including the current iPadOS 26) that you install from your Windows PC — no App Store, no Mac. It is the same app as the web app and the Android app (a Capacitor shell around `web/`), so every screen works the same: inbox, drafts, chat with Claude, compose, to-dos, calendar, contacts, settings.

You can still use the Home Screen web app (Safari → Share → Add to Home Screen) instead of, or alongside, this one. See "Which one?" at the end.

## What you need

- Your iPad and a USB cable.
- Your Windows PC with **iTunes** and **iCloud** installed — the versions from apple.com, **not** the Microsoft Store versions (Sideloadly needs Apple's drivers).
- **Sideloadly** (free, sideloadly.io).
- An **Apple ID**. A free one works (see limits below); a paid Apple Developer account ($99/year) removes them.
- The server reachable from the iPad over HTTPS — the same address you use in Safari today (e.g. your Tailscale `https://…ts.net` address).

## 1. Build the app (once per update, ~10 minutes, on GitHub)

1. Open the repository on GitHub → **Actions** → **iOS app (IPA)** → **Run workflow**.
2. Optional: put your server address in *Server address to pre-fill*. Leave it empty if you'd rather type it on the sign-in screen (it isn't then written in the build log). You can also save it once as a repository variable called `API_BASE`.
3. Leave *Include push notifications* off unless you have a paid developer account (step 5).
4. When the run is green, open it and download **EmailAssistant-ipa** under *Artifacts*. Unzip it: you get `EmailAssistant-v….ipa`.

The build is unsigned on purpose: Sideloadly signs it with your own Apple ID in the next step.

## 2. Put it on the iPad

1. Connect the iPad by USB, unlock it and tap **Trust** if asked.
2. Open Sideloadly, drag the `.ipa` in, pick your iPad, enter your Apple ID, press **Start** and approve the two-factor code if Apple asks. (Sideloadly is a third-party tool that signs in to Apple with that account; if you'd rather not use your main Apple ID, create a separate free one just for sideloading.)
3. On the iPad: **Settings → Privacy & Security → Developer Mode → On**, restart, confirm. (Only the first time; iPadOS asks for this for any sideloaded app.)
4. **Settings → General → VPN & Device Management** → tap your Apple ID under *Developer App* → **Trust**.
5. Open **Email Assistant**. Enter the server address if it isn't pre-filled, then sign in with your password and authenticator code.

## Free Apple ID limits

- **The app stops opening after 7 days.** Re-run Sideloadly with the same `.ipa` (your data stays). Sideloadly's *auto-refresh* can do this over Wi-Fi while the PC is on.
- At most 3 sideloaded apps on the device.
- **No push notifications** — Apple doesn't allow them for free-account apps. Settings → Enable notifications says so. Keep the Home Screen web app for notifications if you need them.
- Sideloadly may change the app's internal ID slightly; that's normal.

A paid Apple Developer account makes the app last a year and allows push.

## 3. Updating

Run the workflow again and sideload the new `.ipa` over the old one. Your sign-in and data stay. (The app's screens are built in, so changes to the app need a new `.ipa`; server-only changes don't.)

## 4. Things that work differently from Safari

| Feature | In the iPad app |
|---|---|
| Sign-in | Password + authenticator code. Passkeys / Face ID sign-in work only in the Safari version (same as Android). The auto-lock still works. |
| Long-press the app icon | **Drafts waiting** and **Chat with Claude** |
| "Draft from shared text" | iPadOS has no share target without an extension, so use a Shortcut: Shortcuts app → **+** → add *Receive* **Text** *from* **Share Sheet**, then **URL** `assistant://open#/share?text=` followed by *URL Encode* of *Shortcut Input*, then **Open URLs**. Name it "Draft reply". It now appears in every app's Share menu. |
| Links `assistant://open#/inbox`, `#/drafts`, `#/chat`… | Open the app on that screen (handy in Shortcuts or Notes). |
| Offline | Same as Safari: opened emails and drafts stay readable, edits sync when back online. |

## 5. Push notifications (paid developer account only)

1. developer.apple.com → Certificates, IDs & Profiles → **Keys** → **+** → tick *Apple Push Notifications service (APNs)* → download the `.p8` file (once only). Note the **Key ID** and your **Team ID** (top right).
2. On the server, in `.env`:
   ```
   APNS_KEY=C:\path\to\AuthKey_XXXXXXXXXX.p8
   APNS_KEY_ID=XXXXXXXXXX
   APNS_TEAM_ID=YYYYYYYYYY
   APNS_BUNDLE_ID=ca.matthewmenard.assistant
   APNS_PRODUCTION=false
   ```
   `APNS_BUNDLE_ID` must match the app's bundle ID as installed (Sideloadly shows it). Sideloaded apps use Apple's *development* push service, so keep `APNS_PRODUCTION=false`. Restart the server.
3. Run the workflow with **Include push notifications** ticked, sideload with your paid account, then in the app: Settings → **Enable notifications on this device**.

Notifications carry only the sender and subject, like on every other device.

## Which one?

| | Home Screen web app (Safari) | Sideloaded app |
|---|---|---|
| Install | Share → Add to Home Screen | Sideloadly from a PC |
| Updates | Automatic | Rebuild + sideload |
| Push | Yes (iPadOS 16.4+) | Paid account only |
| Passkeys | Yes | No |
| Icon quick actions, `assistant://` links | No | Yes |
| Keeps working | Always | 7 days (free) / 1 year (paid) per install |

## For developers

- Project: `ios/` (Capacitor 7, Swift Package Manager — no CocoaPods). `ios/App/App/public`, `capacitor.config.json` and `config.xml` are generated by `npx cap sync ios` and git-ignored.
- Native code is only `ios/App/App/AppDelegate.swift` (quick actions, links, push token). `Info.plist` holds the `assistant://` scheme and quick actions.
- On a Mac: `npm ci`, `VITE_API_BASE=https://… npm run build -w web`, `npx cap sync ios`, `npx cap open ios`, pick your team, Run.
- The iOS WebView's origin is `capacitor://localhost`; it must be in `APP_ORIGINS` (it is by default).
- Server side: `backend/src/notify/apns.ts` (token auth, HTTP/2), subscriptions of kind `apns`.
