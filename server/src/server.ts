/**
 * Keyhole server: a minimal private file store for the Keyhole Obsidian plugin.
 *
 *   PUT    /f/<key>   upload (bearer token)
 *   GET    /f/<key>   download (bearer token or signed URL), supports Range
 *   HEAD   /f/<key>   metadata
 *   DELETE /f/<key>   delete (bearer token)
 *   GET    /health    liveness check, no auth
 *
 * No dependencies beyond Node.js. Put it behind a TLS-terminating reverse proxy.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { safeEqual, verifySignature } from "./sign.ts";

export interface Config {
	dataDir: string;
	tokens: string[];
	maxUploadBytes: number;
	port: number;
	host: string;
}

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidKey(key: string): boolean {
	if (key.length === 0 || key.length > 512) return false;
	return key.split("/").every((s) => KEY_SEGMENT.test(s) && !s.includes(".."));
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	heic: "image/heic",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	flac: "audio/flac",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	pdf: "application/pdf",
	txt: "text/plain; charset=utf-8",
};

function mimeOf(key: string): string {
	const ext = key.split(".").pop()?.toLowerCase() ?? "";
	return MIME[ext] ?? "application/octet-stream";
}

/** Headers on every response: nothing served here may run scripts or be framed. */
function baseHeaders(res: ServerResponse): void {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function send(res: ServerResponse, status: number, body = ""): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.end(body ? `${body}\n` : undefined);
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === "" && m[2] === "")) return "invalid";
	let start: number;
	let end: number;
	if (m[1] === "") {
		const suffix = Number(m[2]);
		if (suffix === 0) return "invalid";
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	}
	if (start > end || start >= size) return "invalid";
	return { start, end };
}

export function createHandler(config: Config) {
	const root = resolve(config.dataDir);

	function pathFor(key: string): string {
		const full = resolve(root, ...key.split("/"));
		if (!full.startsWith(root + sep)) throw new Error("path escapes data dir");
		return full;
	}

	function bearerOk(req: IncomingMessage): boolean {
		const header = req.headers.authorization ?? "";
		const m = /^Bearer (.+)$/.exec(header);
		const token = m?.[1];
		return token !== undefined && config.tokens.some((t) => safeEqual(t, token));
	}

	return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		baseHeaders(res);
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";

		if (url.pathname === "/health") return send(res, 200, "ok");
		if (!url.pathname.startsWith("/f/")) return send(res, 404, "not found");

		// GET /f/?list=1[&prefix=…] → JSON list of stored files (bearer token only).
		if (url.pathname === "/f/" && method === "GET" && url.searchParams.has("list")) {
			if (!bearerOk(req)) {
				res.setHeader("WWW-Authenticate", 'Bearer realm="keyhole"');
				return send(res, 401, "unauthorized");
			}
			const prefix = url.searchParams.get("prefix") ?? "";
			const files: { key: string; size: number; lastModified: number }[] = [];
			const entries = await readdir(root, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || entry.name.startsWith(".upload-")) continue;
				const full = join(entry.parentPath, entry.name);
				const key = relative(root, full).split(sep).join("/");
				if (!key.startsWith(prefix) || !isValidKey(key)) continue;
				const info = await stat(full);
				files.push({ key, size: info.size, lastModified: info.mtimeMs });
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Cache-Control", "no-store");
			res.end(JSON.stringify(files));
			return;
		}

		let key: string;
		try {
			key = decodeURIComponent(url.pathname.slice(3));
		} catch {
			return send(res, 400, "bad key");
		}
		if (!isValidKey(key)) return send(res, 400, "bad key");
		const file = pathFor(key);

		const signed =
			(method === "GET" || method === "HEAD") &&
			url.searchParams.has("ks") &&
			verifySignature(config.tokens, "GET", key, Number(url.searchParams.get("ke")), url.searchParams.get("ks") ?? "");
		if (!signed && !bearerOk(req)) {
			res.setHeader("WWW-Authenticate", 'Bearer realm="keyhole"');
			return send(res, 401, "unauthorized");
		}

		if (method === "GET" || method === "HEAD") {
			let info;
			try {
				info = await stat(file);
			} catch {
				return send(res, 404, "not found");
			}
			if (!info.isFile()) return send(res, 404, "not found");
			res.setHeader("Content-Type", mimeOf(key));
			res.setHeader("Accept-Ranges", "bytes");
			// Keys are content-addressed, so a file never changes.
			res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
			res.setHeader("Content-Disposition", "inline");
			const range = parseRange(req.headers.range, info.size);
			if (range === "invalid") {
				res.setHeader("Content-Range", `bytes */${info.size}`);
				return send(res, 416, "range not satisfiable");
			}
			const start = range?.start ?? 0;
			const end = range?.end ?? info.size - 1;
			res.statusCode = range ? 206 : 200;
			if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
			res.setHeader("Content-Length", String(info.size === 0 ? 0 : end - start + 1));
			if (method === "HEAD" || info.size === 0) return void res.end();
			await pipeline(createReadStream(file, { start, end }), res);
			return;
		}

		if (method === "PUT") {
			const declared = Number(req.headers["content-length"] ?? "NaN");
			if (Number.isFinite(declared) && declared > config.maxUploadBytes) return send(res, 413, "too large");
			await mkdir(dirname(file), { recursive: true });
			const tmp = join(dirname(file), `.upload-${randomUUID()}`);
			let received = 0;
			req.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > config.maxUploadBytes) req.destroy(new Error("too large"));
			});
			try {
				await pipeline(req, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
				await rename(tmp, file);
			} catch {
				await rm(tmp, { force: true });
				if (received > config.maxUploadBytes) return send(res, 413, "too large");
				return send(res, 500, "upload failed");
			}
			return send(res, 201, "created");
		}

		if (method === "DELETE") {
			await rm(file, { force: true });
			return send(res, 204);
		}

		res.setHeader("Allow", "GET, HEAD, PUT, DELETE");
		return send(res, 405, "method not allowed");
	};
}

async function loadTokens(): Promise<string[]> {
	const raw = process.env.KEYHOLE_TOKENS_FILE
		? await readFile(process.env.KEYHOLE_TOKENS_FILE, "utf8")
		: (process.env.KEYHOLE_TOKENS ?? "");
	const tokens = raw
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (!tokens.length) throw new Error("Set KEYHOLE_TOKENS or KEYHOLE_TOKENS_FILE");
	if (tokens.some((t) => t.length < 32)) throw new Error("Tokens must be at least 32 characters (use: openssl rand -hex 32)");
	return tokens;
}

export async function main(): Promise<void> {
	const config: Config = {
		dataDir: process.env.KEYHOLE_DATA_DIR ?? "./data",
		tokens: await loadTokens(),
		maxUploadBytes: Number(process.env.KEYHOLE_MAX_UPLOAD_MB ?? "512") * 1024 * 1024,
		port: Number(process.env.PORT ?? "8080"),
		host: process.env.HOST ?? "0.0.0.0",
	};
	await mkdir(config.dataDir, { recursive: true });
	const handle = createHandler(config);
	const server = createServer((req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) send(res, 500, "internal error");
			else res.destroy();
		});
	});
	server.requestTimeout = 0; // large uploads on slow mobile connections
	server.listen(config.port, config.host, () => {
		// Never log tokens or request URLs (signed URLs carry signatures).
		console.log(`keyhole-server listening on ${config.host}:${config.port}, data in ${resolve(config.dataDir)}`);
	});
	const stop = () => server.close(() => process.exit(0));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
