# Changelog

## 0.4.6

Hardening after a security review. No change to notes or links.

- Secrets are tied to the server they were saved for. If the storage address in the settings changes to another host, Keyhole asks for the secret again instead of sending a token or password there. Existing secrets are tied to the configured server on first start.
- The keychain entries Keyhole reads are fixed in the code and can no longer be chosen through the settings file.
- Clean up storage only offers files that Keyhole uploaded under this vault's key prefix, never other files in the same bucket.
- Moving attachments keeps local files that a canvas still uses.
- Files show up right after Keyhole is switched on. Before, the notes stayed empty until Obsidian was restarted if the settings were open in their own window.
- PDFs are rendered with code evaluation switched off in pdf.js.
- Keyhole no longer undoes other plugins' changes to link handling when it is switched off, and it copes with Obsidian versions that do not let plugins change the mobile toolbar.
- "Bring back into the vault" in the file viewer reports failures instead of always reporting success.
- README: more precise about what is synced (settings, including the access key ID), what the storage provider sees (file names), the clipboard and the offline cache.

## 0.4.5

- Release files come with GitHub artifact attestations (verifiable build provenance).
- Styles no longer use `!important` or `:has()` (faster style updates, easier for themes to override).
- README explains why Keyhole reads all notes (clean-up, restore) and the clipboard (paste, copy link).

## 0.4.4

- "Clear offline cache" also reloads the files in open notes, so they come fresh from storage right away.

## 0.4.3

- PDF box in notes is a little lower (65 % of the window instead of 70 %).

## 0.4.2

- PDFs and other embeds always fit the note width (on iOS a PDF could grow to its pixel width and scroll sideways).
- File viewer shows "Loading…" right away and hides PDFs of the note behind it while open (iOS drew them through the window).

## 0.4.1

- Hint bar sits in the scrolling note content below the title (it hid under the floating header on phones and did not scroll).
- PDF viewer: page count, pages rendered only near the visible area and released when far away (long PDFs on phones), stable layout while scrolling, the file name from the link.
- Clean-up explains when only recent unused files exist.

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
