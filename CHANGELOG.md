# Changelog

## 0.1.0 – unreleased

- Upload on paste and drop, plus an *Upload files* picker with multi-select (ribbon, command, editor menu).
- Storage: S3-compatible (SigV4 on Web Crypto), WebDAV, and the Keyhole server.
- Rendering of `keyhole://` embeds in Reading view and Live Preview: images, PDF (pdf.js), audio and video (streamed via signed URLs), download cards for other files.
- Credentials in Obsidian's device-local keychain; offline cache in IndexedDB.
- Fallback to a local attachment when an upload fails.
- Keyhole server: zero-dependency Node server with bearer tokens, signed URLs and Range support.
