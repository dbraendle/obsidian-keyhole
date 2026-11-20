# Changelog

## 0.4.0

- Right-click (long-press) menu on Keyhole files: open, copy link, download/share, bring back into the vault, delete from storage.
- Plain links `[text](keyhole://…)` open the file in a viewer.
- Bring Keyhole files back into the vault, per note or for the whole vault – your way out.
- Clean up storage: lists files no note in this vault uses anymore; delete what you pick (files from the last 7 days hidden by default).
- Hint bar on notes that still have local attachments, with a one-tap move.
- Keyhole server: `GET /f/?list=1` lists stored files (bearer token only).
- Proper singular/plural texts.

## 0.3.0

- Interface in English and German, following Obsidian's language setting. More languages: add a file in `src/i18n/`.
- Moving attachments reports attachments that are not on this device yet (e.g. still syncing) instead of skipping them silently.

## 0.2.0

- Move a note's local attachments to your storage (command and note context menu): uploads, shrinks images, rewrites embeds (sizes like `|300` are kept), trashes local files no other note uses.
- Setting: remove local copies after moving (on by default).

## 0.1.0 – unreleased

- Upload on paste and drop, plus an *Upload files* picker with multi-select (ribbon, command, editor menu).
- Storage: S3-compatible (SigV4 on Web Crypto), WebDAV, and the Keyhole server.
- Rendering of `keyhole://` embeds in Reading view and Live Preview: images, PDF (pdf.js), audio and video (streamed via signed URLs), download cards for other files.
- Credentials in Obsidian's device-local keychain; offline cache in IndexedDB.
- Fallback to a local attachment when an upload fails.
- Keyhole server: zero-dependency Node server with bearer tokens, signed URLs and Range support.
