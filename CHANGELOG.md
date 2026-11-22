# Changelog

## 0.11.4

- Adds Buy Me a Coffee as a third funding link. No functional change.

## 0.11.3

- Adds Ko-fi as a second funding link. No functional change.

## 0.11.2

- Pasting: whether the clipboard holds real text next to a picture is now decided by a small scanner that only looks at the text between tags, instead of stripping tags with patterns (a code-scanning finding). The result was only ever used as a yes/no; nothing from the clipboard was inserted as HTML.

## 0.11.1

- Adds a funding link (GitHub Sponsors) to the plugin's entry in Obsidian. No functional change.

## 0.11.0

- One switch per kind of file instead of the choice "all files / media only / images only": pictures, audio, video, PDFs and other files can be turned on and off separately, for example to upload PDFs only. An existing choice is carried over.

## 0.10.0

- Set-up guide: the first time Keyhole is enabled in a vault without storage, a guide goes through storage (with a connection test), uploads, encryption, the upload button on phones and the attachments already in the vault. On a device that has the vault's settings but not its secret or encryption key, a short version asks only for those. Both open once, can be left at any point, and are available again from the settings and the command palette.
- "Move all" in the file overview moves every local attachment that notes show to the storage in one go.

## 0.9.0

- The upload button in the mobile toolbar can take the place of the paper clip, so that the one button left uploads instead of saving into the vault. The setting has three choices now: not in the toolbar, next to the paper clip, instead of the paper clip. Keyhole puts the paper clip back when it is switched off or uninstalled.
- The question Keyhole asks once on a phone or tablet offers both placements.

## 0.8.0

- File overview (Settings → Keyhole, or the command palette): one window that lists the attachments stored in the vault and the files in your storage, with sizes. Each file can be uploaded or brought back on its own.
- "Metadata in pictures" is a setting of its own now, independent of shrinking: keep everything, remove the location, or remove everything. JPEG and PNG are cleaned without re-encoding. Before, a picture lost all metadata when it was shrunk and kept all of it otherwise.
- A picture that could not be made smaller was uploaded with its location even though shrinking was on. Its metadata is now treated like that of every other picture.
- The upload button for the mobile toolbar is a switch that shows whether the button is there and removes it again.

Existing settings keep their behaviour: with shrinking on, metadata is removed as before; with shrinking off, it is kept as before.

## 0.7.1

- "Storage name in links" can no longer be changed by typing into a field. The setting shows the current name and explains what it is; changing it goes through a dialog that counts the links in the vault that would stop working.
- Clearer description for "Folder in storage".

## 0.7.0

- "Encrypt existing files" (Settings → Keyhole → Encryption, or the command palette): files uploaded before encryption was turned on are uploaded again encrypted, and the links in notes and canvases are rewritten. The old unencrypted copies stay in the storage until you remove them with "Clean up storage".
- The Keyhole server lives in its own repository now: https://github.com/dbraendle/keyhole-server. Nothing changes for the plugin or for running servers.

## 0.6.0

- Optional end-to-end encryption (Settings → Keyhole → Encryption). Files are encrypted on the device with AES-256-GCM before upload; the storage provider sees neither content nor file names. You get a key that you save in your password manager and paste once on every device. There is no recovery if the key is lost, so encryption only turns on after you pasted the saved key back.
- Encrypted files keep their name in the link (`…/<id>.khe#photo.jpg`); existing links and files are unchanged and stay unencrypted.
- The offline cache keeps encrypted files encrypted.
- Encrypted audio and video are downloaded completely instead of streamed.

## 0.5.0

- Large files on S3-compatible storage are uploaded in parts (multipart upload, 8 MB each, for files over 16 MB). Only one part is in memory at a time, which avoids crashes with big videos on phones. If a part fails, the unfinished upload is aborted, so no leftovers are stored.
- Keys stay the same: the content hash is now computed piece by piece for large files.

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
