import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { Sha256, sha256HexOfBlob } from "../src/sha256";
import { blobSource } from "../src/storage/source";
import { completeBody, multipartUpload, partSizeFor, type SendRequest, type SendResponse } from "../src/storage/multipart";

const creds = { accessKeyId: "AKID", secretAccessKey: "secret", region: "auto" };

function bytes(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) % 251;
	return out;
}

describe("incremental SHA-256", () => {
	it("matches known vectors", async () => {
		expect(await sha256HexOfBlob(new Blob([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(await sha256HexOfBlob(new Blob(["abc"]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("matches Web Crypto for every length around the block boundaries", async () => {
		for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
			const data = bytes(length);
			expect(await sha256HexOfBlob(new Blob([data]), 7), `length ${length}`).toBe(await sha256Hex(data));
		}
	});

	it("gives the same result however the data is split", async () => {
		const data = bytes(300_000);
		const expected = await sha256Hex(data);
		expect(await sha256HexOfBlob(new Blob([data]), 64)).toBe(expected);
		expect(await sha256HexOfBlob(new Blob([data]), 99_991)).toBe(expected);
		const hash = new Sha256();
		hash.update(data.subarray(0, 1)).update(data.subarray(1, 200_000)).update(data.subarray(200_000));
		expect(Array.from(new Uint8Array(hash.digest()), (b) => b.toString(16).padStart(2, "0")).join("")).toBe(expected);
	});
});

describe("multipart upload", () => {
	const url = new URL("https://s3.example.com/bucket/2026/11/0123456789abcdef-video.mp4");

	function fakeStorage(failAtPart = 0) {
		const requests: SendRequest[] = [];
		const send = async (request: SendRequest): Promise<SendResponse> => {
			requests.push(request);
			const target = new URL(request.url);
			if (request.method === "POST" && target.searchParams.has("uploads")) {
				return { text: "<InitiateMultipartUploadResult><UploadId>up&amp;1</UploadId></InitiateMultipartUploadResult>", headers: {} };
			}
			if (request.method === "PUT") {
				const n = Number(target.searchParams.get("partNumber"));
				if (n === failAtPart) throw new Error("connection lost");
				return { text: "", headers: { ETag: `"etag-${n}"` } };
			}
			return { text: "<CompleteMultipartUploadResult/>", headers: {} };
		};
		return { requests, send };
	}

	it("uploads the parts in order and completes with their ETags", async () => {
		const { requests, send } = fakeStorage();
		const data = bytes(25);
		await multipartUpload(send, creds, url, blobSource(new Blob([data])), "video/mp4", 10);

		expect(requests.map((r) => r.method)).toEqual(["POST", "PUT", "PUT", "PUT", "POST"]);
		expect(requests[0]?.headers["content-type"]).toBe("video/mp4");
		const parts = requests.filter((r) => r.method === "PUT");
		expect(parts.map((r) => new URL(r.url).searchParams.get("partNumber"))).toEqual(["1", "2", "3"]);
		expect(parts.map((r) => (r.body as ArrayBuffer).byteLength)).toEqual([10, 10, 5]);
		expect(parts.every((r) => new URL(r.url).searchParams.get("uploadId") === "up&1")).toBe(true);
		const joined = new Uint8Array(25);
		let at = 0;
		for (const r of parts) {
			joined.set(new Uint8Array(r.body as ArrayBuffer), at);
			at += (r.body as ArrayBuffer).byteLength;
		}
		expect(joined).toEqual(data);
		expect(requests[4]?.body).toBe(completeBody(['"etag-1"', '"etag-2"', '"etag-3"']));
		// Every request is signed; the secret itself is never sent.
		expect(requests.every((r) => r.headers["authorization"]?.startsWith("AWS4-HMAC-SHA256 Credential=AKID/"))).toBe(true);
		expect(JSON.stringify(requests.map((r) => [r.url, r.headers]))).not.toContain("secret");
	});

	it("aborts the upload when a part fails", async () => {
		const { requests, send } = fakeStorage(2);
		await expect(multipartUpload(send, creds, url, blobSource(new Blob([bytes(25)])), "video/mp4", 10)).rejects.toThrow("connection lost");
		const last = requests.at(-1);
		expect(last?.method).toBe("DELETE");
		expect(new URL(last?.url ?? url).searchParams.get("uploadId")).toBe("up&1");
		expect(requests.some((r) => r.method === "POST" && !new URL(r.url).searchParams.has("uploads"))).toBe(false);
	});

	it("reports an error that arrives with status 200", async () => {
		const send = async (request: SendRequest): Promise<SendResponse> => {
			const target = new URL(request.url);
			if (target.searchParams.has("uploads")) return { text: "<UploadId>u</UploadId>", headers: {} };
			if (request.method === "PUT") return { text: "", headers: { etag: '"e"' } };
			if (request.method === "POST") return { text: "<Error><Code>InternalError</Code><Message>Try again</Message></Error>", headers: {} };
			return { text: "", headers: {} };
		};
		await expect(multipartUpload(send, creds, url, blobSource(new Blob([bytes(5)])), "video/mp4", 10)).rejects.toThrow("Try again");
	});

	it("keeps within 10,000 parts and escapes ETags", () => {
		expect(partSizeFor(100 * 1024 * 1024)).toBe(8 * 1024 * 1024);
		expect(partSizeFor(200 * 1024 * 1024 * 1024)).toBeGreaterThan(8 * 1024 * 1024);
		expect(Math.ceil((200 * 1024 * 1024 * 1024) / partSizeFor(200 * 1024 * 1024 * 1024))).toBeLessThanOrEqual(10_000);
		expect(completeBody(["a&<b>"])).toBe(
			"<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>a&amp;&lt;b&gt;</ETag></Part></CompleteMultipartUpload>",
		);
	});
});
