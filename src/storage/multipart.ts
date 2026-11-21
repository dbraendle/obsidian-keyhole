/**
 * S3 multipart upload: the file goes up in parts of a few megabytes, so only one
 * part is in memory at a time. `requestUrl` cannot stream a request body, which is
 * why a single PUT of a large file can exhaust the memory of a phone.
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
 */
import { sha256Hex } from "../crypto";
import { tag } from "./listing";
import { EMPTY_SHA256, signHeaders, type Credentials } from "./sigv4";
import type { ByteSource } from "./source";

/** Every part but the last must be at least 5 MiB; R2 also wants them equal in size. */
export const PART_BYTES = 8 * 1024 * 1024;
/** Files up to this size go up in a single request. */
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
/** S3 allows 10,000 parts per upload. */
const MAX_PARTS = 10_000;

export interface SendRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: ArrayBuffer | string;
}

export interface SendResponse {
	text: string;
	headers: Record<string, string>;
}

/** Sends a signed request; rejects on network errors and on HTTP status 400 and above. */
export type Send = (request: SendRequest) => Promise<SendResponse>;

function header(headers: Record<string, string>, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
	return null;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function partSizeFor(totalBytes: number, preferred = PART_BYTES): number {
	return Math.max(preferred, Math.ceil(totalBytes / MAX_PARTS));
}

export function completeBody(etags: string[]): string {
	const parts = etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
	return `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`;
}

/**
 * Uploads `source` to `objectUrl` in parts. If anything fails, the unfinished upload is
 * aborted (best effort), so no orphaned parts are left to be paid for.
 */
export async function multipartUpload(
	send: Send,
	creds: Credentials,
	objectUrl: URL,
	source: ByteSource,
	contentType: string,
	partBytes = PART_BYTES,
): Promise<void> {
	const signed = async (method: string, url: URL, headers: Record<string, string>, body?: ArrayBuffer | string) =>
		send({
			url: url.toString(),
			method,
			headers: await signHeaders(creds, { method, url, headers, payloadHash: body === undefined ? EMPTY_SHA256 : await sha256Hex(body) }),
			body,
		});

	const createUrl = new URL(objectUrl);
	createUrl.searchParams.set("uploads", "");
	const created = await signed("POST", createUrl, { "content-type": contentType });
	const uploadId = tag(created.text, "UploadId");
	if (!uploadId) throw new Error("The storage did not start a multipart upload");

	const withUpload = (extra: Record<string, string> = {}): URL => {
		const url = new URL(objectUrl);
		for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
		url.searchParams.set("uploadId", uploadId);
		return url;
	};

	try {
		const size = partSizeFor(source.size, partBytes);
		const etags: string[] = [];
		for (let offset = 0; offset < source.size; offset += size) {
			const part = await source.read(offset, Math.min(offset + size, source.size));
			const res = await signed("PUT", withUpload({ partNumber: String(etags.length + 1) }), {}, part);
			const etag = header(res.headers, "etag");
			if (!etag) throw new Error("The storage returned no ETag for an uploaded part");
			etags.push(etag);
		}
		const done = await signed("POST", withUpload(), { "content-type": "application/xml" }, completeBody(etags));
		// S3 can answer 200 and still report a failure in the body.
		if (/<Error\b/i.test(done.text)) throw new Error(tag(done.text, "Message") ?? "The storage could not complete the upload");
	} catch (err) {
		await signed("DELETE", withUpload(), {}).catch(() => undefined);
		throw err;
	}
}
