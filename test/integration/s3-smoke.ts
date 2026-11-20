/**
 * Smoke test of the SigV4 code against a real S3-compatible server.
 * Not part of the unit tests; run it manually or in CI with a throwaway server:
 *
 *   S3_ENDPOINT=http://127.0.0.1:8333 S3_REGION=us-east-1 S3_BUCKET=keyhole-smoke \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... pnpm smoke:s3
 *
 * Creates the bucket if needed, uploads, downloads, and fetches a presigned URL.
 */
import { EMPTY_SHA256, presignUrl, signHeaders } from "../../src/storage/sigv4";
import { sha256Hex } from "../../src/crypto";

const env = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};

const endpoint = env("S3_ENDPOINT").replace(/\/$/, "");
const bucket = env("S3_BUCKET");
const creds = {
	accessKeyId: env("S3_ACCESS_KEY_ID"),
	secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
	region: process.env.S3_REGION ?? "us-east-1",
};

async function call(method: string, path: string, body?: Uint8Array<ArrayBuffer>, contentType?: string): Promise<Response> {
	const url = new URL(`${endpoint}${path}`);
	const headers = await signHeaders(creds, {
		method,
		url,
		headers: contentType ? { "content-type": contentType } : {},
		payloadHash: body ? await sha256Hex(body) : EMPTY_SHA256,
	});
	return fetch(url, { method, headers, body });
}

const key = `2026/11/0123456789abcdef-smoke test ä.txt`;
const path = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
const content = new TextEncoder().encode(`keyhole smoke ${new Date().toISOString()}`);

const created = await call("PUT", `/${bucket}`);
console.log("create bucket:", created.status);
const put = await call("PUT", path, content, "text/plain");
console.log("put:", put.status);
if (!put.ok) throw new Error(await put.text());
const get = await call("GET", path);
const text = await get.text();
console.log("get:", get.status, text === new TextDecoder().decode(content) ? "content ok" : "CONTENT MISMATCH");
if (!get.ok) throw new Error(text);
const signed = await presignUrl(creds, "GET", new URL(`${endpoint}${path}`), 300);
const viaUrl = await fetch(signed);
console.log("presigned get:", viaUrl.status, (await viaUrl.text()) === text ? "content ok" : "CONTENT MISMATCH");
const unsigned = await fetch(`${endpoint}${path}`);
console.log("unsigned get (must be denied):", unsigned.status);
if (!viaUrl.ok || unsigned.ok) process.exit(1);
