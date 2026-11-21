# Keyhole – concept

Status: v0.4, November 2026. This document records the decisions behind Keyhole and the traps that shaped them.

## Goal

Attachments (images, PDFs, audio, video, any file) live on storage the user controls, not in the vault. They stay private and still feel like normal attachments: drop or paste a file, and it shows up in the note on desktop and mobile, in Reading view and Live Preview, and offline where possible. The vault, and Obsidian Sync, stay small.

## Does the idea hold? Prior art

Uploading attachments is a solved problem; keeping them private while showing them is not.

- **Image Auto Upload, Image Upload Toolkit, S3 Image Uploader, Imgur**: upload on paste or drop and write a public URL. The file is readable by anyone who has the link. This is the opposite of what we want.
- **Aktar** (MIT, listed in the directory since 10/2026, unreviewed): the closest relative. It renders private S3 objects through presigned URLs, with SecretStorage and an image cache. But it keeps plain `https://` links in notes, so Obsidian fires one unauthenticated request before the swap. It is S3 only, caches only images offline, and has no PDF viewer.
- **Vault S3 Bridge, NotePix, File Relay, Unchanged Attachments to OSS**: each solves part of the problem. They are desktop-only, tied to one provider, or keep data in memory only.

Keyhole's niche: standards-based storage (S3-compatible *and* a token-protected HTTP/WebDAV server), every file type, desktop *and* mobile, offline cache for everything, and a link format that never makes a request on its own.

## Key decisions

### 1. Link format: `![name](keyhole://<alias>/<key>)`

- **A private scheme, not an https URL.** Obsidian's sanitizer allows unknown protocols (`ALLOW_UNKNOWN_PROTOCOLS: true` in 1.15). We verified that `![](keyhole://…)` becomes an `<img>` in both Reading view and Live Preview, for every extension. The browser cannot load the scheme, so nothing leaves the device until Keyhole resolves it. An https link would leak one unauthenticated request per view and flash a broken image.
- **Alias instead of host.** `main` names a storage in the settings. Moving from one provider to another means changing settings, not notes.
- **Content-addressed keys.** `{prefix}{yyyy}/{mm}/{sha256[0:16]}-{safe-name}`. The same file always maps to the same key, so caches never go stale and duplicate uploads cost nothing.
- **Trade-off:** without the plugin the embed shows as broken. It still shows a readable file name, and it never makes an unauthenticated request.

### 2. Credentials never touch the vault

- Tokens and secret keys live in Obsidian's keychain (`app.secretStorage`, 1.11.4+), which is device-local: encrypted with the OS keychain on desktop and native secure storage on mobile.
- `data.json` (which may be synced or committed) holds only the *name* of the keychain entry. The names are fixed in the code; the setting is never used to choose which entry is read.
- Each secret is bound to the origin it was saved for (a second keychain entry, `<name>-host`). The storage URL is a synced setting, so without the binding anyone who can change `data.json` could redirect a bearer token or Basic password to their own server. On a mismatch Keyhole refuses and asks for the secret again.
- The DOM only ever sees `blob:` URLs, or short-lived signed URLs for streaming that carry a signature, never a token.
- Error messages never echo headers or signed URLs.

### 3. Rendering: one observer for every surface

- Obsidian keeps owning the `<img>`. A `MutationObserver` on each window's body finds `img[src^="keyhole:"]`, and a Markdown post-processor resolves Reading view sections before they are attached.
- This covers Live Preview, Reading view, hover popovers, embeds, Canvas and the lightbox (verified: the image viewer picks up the swapped `blob:` URL).
- **Images**: `blob:` URL, served from memory, then the IndexedDB cache, then a download.
- **Audio and video**: a cached copy if there is one, otherwise a signed URL that streams with Range requests. This avoids loading whole videos into memory on phones.
- **PDF**: rendered with Obsidian's own pdf.js (`loadPdfJs`), with pages drawn lazily.
- **Other files**: a card with a download button that uses the share sheet on mobile.
- **Lessons from other plugins applied:**
  - never revoke blob URLs because a node left the DOM, since Live Preview moves nodes constantly; evict by memory size instead;
  - re-check the element after every await, since nodes get reused;
  - the inline-flex `.image-wrapper` collapses non-image embeds, so CSS overrides it.

### 4. Storage: standards, no SDKs

| Backend | Covers | Auth | Streaming |
|---|---|---|---|
| S3-compatible | AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Garage, SeaweedFS, MinIO | SigV4, hand-written on Web Crypto (verified against AWS test vectors and a real server) | presigned GET |
| WebDAV | Nextcloud, Synology, rclone serve webdav, Caddy, nginx | Basic or Bearer | no (full download) |
| Keyhole server | own server, 1 file, 0 dependencies | Bearer | HMAC-signed URL |

- All HTTP goes through `requestUrl`, which bypasses CORS on desktop and mobile, so no bucket CORS setup is needed.
- No AWS SDK: bundle size, and the SDK's fetch handler fails CORS.
- The **Keyhole server** (`server/`) exists because plain WebDAV cannot stream to `<video>`: media elements cannot send an Authorization header. It adds short-lived signed URLs, Range support and hardened response headers (`nosniff`, CSP sandbox).

### 5. Uploads

- Workspace events `editor-paste` and `editor-drop`. Keyhole respects `defaultPrevented`, leaves mixed drops and rich-text pastes (Office, mail) to Obsidian, and only takes files that match the configured scope and size.
- **Placeholder** `![name](keyhole://uploading/<id>)` is rendered as an "Uploading…" pill and then replaced:
  - in any open editor, with `replaceRange`, so cursor and undo history survive;
  - otherwise in the file with `vault.process`;
  - if the user deleted it meanwhile, the link goes to the clipboard.
- **Failure** (offline, storage down): the file is saved as a normal local attachment instead of being lost. This is a setting, on by default.
- **Multi-select picker**: the "Upload files" command, ribbon button and editor menu open the system picker with `multiple`. On phones this is the native picker (photo library, camera, files), where many files can be picked at once. Obsidian's own attachment button takes one file at a time and cannot be intercepted (no API).
- At most 3 uploads run at once, because `requestUrl` holds the whole body in memory.

### 6. Offline

- IndexedDB, outside the vault, never synced.
- LRU, with a size limit and a per-file limit.
- Files are cached when viewed and after upload. The command "Keep attachments of the current note on this device" prefetches a note.

### 7. End-to-end encryption (in progress)

Optional. With it, the storage provider sees only ciphertext and no file names.

- **File format "KHE1"** (`src/e2e/format.ts`, done): 4 bytes magic, 16 bytes random salt, then the plaintext in 1 MiB chunks, each sealed with AES-256-GCM. The file key is HKDF-SHA256(vault key, salt). The nonce is the chunk index plus a last-chunk flag (the STREAM construction, as in age), so chunks cannot be reordered, dropped or cut off unnoticed. Chunks are independent, which allows decrypting a byte range later. Web Crypto only, so it runs on mobile.
- **Vault key**: 32 random bytes in the device keychain, exported as text (`keyhole-key-v1:…`) for the password manager and the other devices. A non-secret fingerprint in the settings lets another device check that the pasted key is the right one. Losing the key means losing the files; there is no recovery.
- **Object names**: `{prefix}yyyy/mm/{keyed hash of the content, 32 hex}.khe`. Deterministic per vault key (uploading twice stores once), meaningless without the key.
- **Open, to be decided before the integration:**
  - where the file name and type live once they are no longer in the object key (proposal: in the link's fragment, `keyhole://main/2026/11/<id>.khe#photo.jpg`, which never leaves the vault and extends the link format without breaking it);
  - random key only, or also a passphrase (PBKDF2; weaker, but nothing to copy between devices);
  - whether the offline cache keeps plaintext (as today) or ciphertext.
- **Consequences**: no streaming (media is downloaded and decrypted as a whole, until range decryption is built); files uploaded before stay readable and unencrypted until they are moved over.

## Known limits and open questions

- **Android is not yet verified on a device.** iOS (iPhone) is. On Android, verify that the scheme renders as `<img>`, paste, the multi-select picker and the share sheet for downloads.
- **`requestUrl` buffers everything.** A request body cannot be streamed. S3 uploads over 16 MB therefore go up as a multipart upload in 8 MB parts, with the content hash computed incrementally (Web Crypto can only hash a complete buffer). The Keyhole server and WebDAV still take one request per file, and downloads are always buffered as a whole.
- **iOS ignores user-installed CA certificates** for `requestUrl`. Self-hosted servers need a publicly trusted certificate (Let's Encrypt).
- **Surfaces that render their own `<img>` from the raw link** (e.g. Bases card covers) may not be covered.
- **Plain WebDAV cannot stream video**; it downloads the file fully. Use S3 or the Keyhole server for large media.
- **Videos that are not cached do not play offline.**
- **Deleting a link does not delete the file.** "Clean up storage" lists unused files; it only offers keys that have the shape Keyhole writes under the vault's prefix.
- **The provider sees plaintext and file names.** Keys contain the file name. See the roadmap for end-to-end encryption.
- **The offline cache is not encrypted** and survives removing the plugin (Obsidian has no uninstall hook).
- **No isolation between plugins.** Any plugin in the vault can read the keychain and blob URLs. This is Obsidian's model, not something Keyhole can change.

## Roadmap

Done: moving a note's local attachments (0.2), image shrinking (0.2), the way back into the vault and storage clean-up (0.4).

1. **Next**
   - Uploads in parts for the Keyhole server too (S3 has them since 0.5).
   - Optional client-side end-to-end encryption (AES-GCM, key in the keychain). Storage providers would see only ciphertext, and keys would no longer carry file names. Streaming then requires a full download.
2. **Later**
   - Several storages at the same time (the alias is already in the link).
   - Show the cache status in settings; offline marker on video.
   - Bases covers.

## Guidelines compliance

- Follows the plugin guidelines: id `keyhole`, `isDesktopOnly: false`, no Node or Electron APIs, `requestUrl` only, no telemetry, eslint-plugin-obsidianmd clean.
- The README discloses network use and the need for a storage account.
- Changes reach `main` only through pull requests with green CI. A version bump on `main` publishes the release automatically.
