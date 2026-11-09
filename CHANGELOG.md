# Changelog

All notable changes. Versions follow MAJOR.MINOR.PATCH and are shared by the server, the web app (PWA) and the Android APK.

## [0.2.0] - 2026-11-09
- **Pick the model for every draft:** a Haiku / Sonnet / Opus picker on each reply (first draft and redraft) and in "Write it with Claude" for new emails, with a one-line note on what each is good for. The picker starts on the model that wrote the current version, so redrafting keeps your choice. **Sonnet is now the default** for automatic and new drafts. Change it in Settings → Models & drafting. Every version still records which model wrote it, so you can compare and revert. "Always draft with" on a person now also offers Haiku.
- **Attach files and PDFs to drafts:** "📎 Attach files" on every reply draft and new email opens your device's file picker (Files, Drive or Photos on iPad and Android). On desktop you can also drag files onto the box. Files someone sent you in the conversation can be re-attached with one tap. Attachments go into the Gmail draft and are listed in the Send confirmation. Gmail's 25 MB per email limit applies, and file types Gmail blocks (programs, scripts) are refused. Adding or removing a file after you reviewed the email needs a fresh review. Files are never sent to Claude.
- **Android:** the app no longer crashes on launch when it was built without Firebase. The sign-in screen says what to check when it can't reach the server.
- **Chat with Claude:** a new Chat tab, and "✦ Ask Claude" on any email. Ask in plain words to find, summarise, archive, snooze, label, mark read, draft or edit replies, start new emails, add or tick off to-dos, add calendar events, block senders or discard drafts. Each action shows as a line with links; discarding, blocking, calendar events and changes to more than 3 emails show a Confirm / Cancel card first. The chat can't send email. If an email contains text trying to instruct an AI, the chat warns you and every change asks first. Chats are saved, follow the retention setting, and are included in export/wipe. Model per chat (default Opus).
- New `POST /api/threads/:id/labels` for your own Gmail labels.

## [0.1.0] - 2026-11-01
- First version: Gmail sync and triage, Claude drafts in your voice saved as Gmail drafts (never sent automatically), correspondent profiles, calendar availability and scheduling cards.
- Apps: iPad (Home Screen web app) and Android (signed APK) sharing one interface; three-pane layout on iPad landscape.
- Model switching Haiku → Sonnet → Opus with version history, compare and revert; usage and budget tracking.
- Security: password + authenticator code, passkeys, auto-lock, audit log, encrypted tokens, prompt-injection defences.
- Mock mode, evaluation harness, Docker deployment, backup/restore scripts.
