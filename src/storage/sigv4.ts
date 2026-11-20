/**
 * AWS Signature Version 4 for S3-compatible storage, built on Web Crypto so it
 * runs on desktop and mobile without the AWS SDK.
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */
import { hmac, sha256Hex, toHex } from "../crypto";

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	service?: string;
}

/** RFC 3986 encoding as S3 expects it. Slashes are kept when encoding a path. */
export function uriEncode(value: string, keepSlash = false): string {
	let out = "";
	for (const byte of new TextEncoder().encode(value)) {
		const ch = String.fromCharCode(byte);
		if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) {
			out += ch;
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

export function amzDate(date: Date): { amzDate: string; dateStamp: string } {
	const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
	return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function canonicalQuery(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? "")}`)
		.join("&");
}

async function signingKey(creds: Credentials, dateStamp: string): Promise<ArrayBuffer> {
	const kDate = await hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
	const kRegion = await hmac(kDate, creds.region);
	const kService = await hmac(kRegion, creds.service ?? "s3");
	return hmac(kService, "aws4_request");
}

async function signature(
	creds: Credentials,
	dateStamp: string,
	amz: string,
	canonicalRequest: string,
): Promise<string> {
	const scope = `${dateStamp}/${creds.region}/${creds.service ?? "s3"}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, await sha256Hex(canonicalRequest)].join("\n");
	return toHex(await hmac(await signingKey(creds, dateStamp), stringToSign));
}

export interface SignRequest {
	method: string;
	url: URL;
	headers: Record<string, string>;
	payloadHash: string;
	date?: Date;
}

/**
 * Signs a request with the Authorization header. Returns the headers to send
 * (the input headers plus x-amz-date, x-amz-content-sha256 and Authorization).
 * `host` is signed but not returned: the HTTP client sets it.
 */
export async function signHeaders(creds: Credentials, req: SignRequest): Promise<Record<string, string>> {
	const { amzDate: amz, dateStamp } = amzDate(req.date ?? new Date());
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
	headers["host"] = req.url.host;
	headers["x-amz-date"] = amz;
	headers["x-amz-content-sha256"] = req.payloadHash;

	const names = Object.keys(headers).sort();
	const query: Record<string, string> = {};
	req.url.searchParams.forEach((v, k) => (query[k] = v));
	const canonicalRequest = [
		req.method.toUpperCase(),
		uriEncode(decodeURIComponent(req.url.pathname), true),
		canonicalQuery(query),
		names.map((n) => `${n}:${headers[n]}\n`).join(""),
		names.join(";"),
		req.payloadHash,
	].join("\n");

	const sig = await signature(creds, dateStamp, amz, canonicalRequest);
	const scope = `${dateStamp}/${creds.region}/${creds.service ?? "s3"}/aws4_request`;
	const out: Record<string, string> = { ...headers };
	delete out["host"];
	out["authorization"] =
		`AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
	return out;
}

/** Creates a presigned URL (query-string authentication), valid for `expiresIn` seconds. */
export async function presignUrl(
	creds: Credentials,
	method: string,
	url: URL,
	expiresIn: number,
	date: Date = new Date(),
): Promise<string> {
	const { amzDate: amz, dateStamp } = amzDate(date);
	const scope = `${dateStamp}/${creds.region}/${creds.service ?? "s3"}/aws4_request`;
	const query: Record<string, string> = {};
	url.searchParams.forEach((v, k) => (query[k] = v));
	Object.assign(query, {
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": `${creds.accessKeyId}/${scope}`,
		"X-Amz-Date": amz,
		"X-Amz-Expires": String(Math.max(1, Math.min(604800, Math.floor(expiresIn)))),
		"X-Amz-SignedHeaders": "host",
	});
	const canonicalPath = uriEncode(decodeURIComponent(url.pathname), true);
	const canonicalRequest = [
		method.toUpperCase(),
		canonicalPath,
		canonicalQuery(query),
		`host:${url.host}\n`,
		"host",
		UNSIGNED_PAYLOAD,
	].join("\n");
	const sig = await signature(creds, dateStamp, amz, canonicalRequest);
	return `${url.protocol}//${url.host}${canonicalPath}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}
