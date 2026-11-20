# Keyhole

Keep your attachments on your own private storage. Drop or paste an image, PDF, recording, video or any other file into a note. Keyhole uploads it to your S3-compatible bucket or your own server and writes the link for you. When you view the note, Keyhole fetches the file with credentials that are stored only on your device. Your vault stays small, and the files stay private.

- **Private by design:** nothing is publicly readable. Notes contain only `keyhole://` links, never tokens or signed URLs.
- **Credentials stay on the device:** they live in Obsidian's keychain, not in your vault, so they are never synced or committed to Git.
- **Works where attachments work:** Reading view, Live Preview, hover previews, Canvas and the image viewer, on desktop and mobile.
- **All kinds of files:**
  - images;
  - PDFs, rendered in the note;
  - audio and video, streamed from S3 or the Keyhole server;
  - any other file, as a download card.
- **Offline:** files you have viewed are kept on the device, up to a size limit you choose.
- **Upload many files at once:** the *Upload files* button opens your system's picker with multi-select. On a phone that means the photo library, the camera or the Files app.
- **Never lose a file:** if an upload fails (you are offline, say), the file is saved as a normal local attachment instead.

> Status: early (0.1). Desktop is tested. Mobile support is built in but still needs verification on real devices. See [docs/CONCEPT.md](docs/CONCEPT.md).

## Storage you can use

| Storage | Examples |
|---|---|
| S3-compatible | AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Garage, SeaweedFS, MinIO |
| Keyhole server | The small server in [`server/`](server/): one file, no dependencies, Docker image |
| WebDAV | Nextcloud, Synology, rclone `serve webdav`, Caddy, nginx |

Keep your bucket **private**. Keyhole never needs public access, and it needs no CORS configuration.

## Setup

1. Install and enable Keyhole.
2. Open **Settings → Keyhole** and choose your storage.
3. Enter the endpoint, bucket and access key ID, or your server URL.
4. Under **Secret access key** (or **Token or password**), create a keychain entry and paste the secret. Do this once on every device: secrets are not synced.
5. Click **Test connection**.

### Cloudflare R2 example

- Endpoint: `https://<account-id>.r2.cloudflarestorage.com`
- Region: `auto`
- Bucket: your private bucket
- Credentials: an R2 API token with *Object Read & Write* on that bucket only

### Keyhole server

```sh
docker run -d -p 8080:8080 -v keyhole-data:/data \
  -e KEYHOLE_TOKENS="$(openssl rand -hex 32)" ghcr.io/dbraendle/keyhole-server:latest
```

Put it behind HTTPS with a publicly trusted certificate (iOS ignores self-installed ones). Then use `https://your-host/f/` as the server URL. See [server/README.md](server/README.md).

## Using it

- **Drop or paste** files into a note. Keyhole takes files that match *Upload these files* and are under the size limit; everything else is left to Obsidian.
- **Upload files** (ribbon icon, command palette or the editor's context menu) picks several files at once. On mobile, add the command to the toolbar.
- **Keep attachments of the current note on this device** downloads all of a note's files for offline use.
- Links look like `![photo.jpg](keyhole://main/2026/11/3f2a9c1e0b7d4a55-photo.jpg)`. You can resize images as usual: `![photo.jpg|300](…)`.

## Privacy and network use

Keyhole connects **only** to the storage you configure, to upload and download your files. It sends no telemetry and contacts no other service. You need an account with an S3-compatible provider (often paid beyond a free tier), or your own server.

- Secrets are stored in Obsidian's keychain on each device.
- The offline cache lives in the app's local storage (IndexedDB) on each device, outside your vault.
- To stream audio and video, Keyhole gives the media player a signed link that expires after a few hours. This is a presigned URL for S3, or an HMAC-signed URL for the Keyhole server. These links exist only while the note is open and are never written to your notes.

## Limitations

- Without Keyhole installed, the embeds show as broken images. The links contain the file name, so nothing is lost.
- Deleting a link does not delete the file from storage.
- Plain WebDAV downloads media completely before playback. Use S3 or the Keyhole server for large videos.
- On mobile, very large files can run into memory limits during upload. The default maximum is 100 MB.

## Development

```sh
pnpm install
pnpm dev        # watch build into main.js
pnpm check      # lint, tests, production build
pnpm smoke:s3   # SigV4 against a real S3 server (see test/integration/s3-smoke.ts)
```

## License

[MIT](LICENSE)
