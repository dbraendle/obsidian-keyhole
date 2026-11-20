import { describe, expect, it } from "vitest";
import { EMPTY_SHA256, presignUrl, signHeaders, uriEncode } from "../src/storage/sigv4";

// Test vectors from the AWS S3 documentation (Signature Version 4 examples).
const creds = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
};
const date = new Date("2013-05-24T00:00:00Z");

describe("SigV4", () => {
	it("signs a GET with a Range header", async () => {
		const headers = await signHeaders(creds, {
			method: "GET",
			url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
			headers: { Range: "bytes=0-9" },
			payloadHash: EMPTY_SHA256,
			date,
		});
		expect(headers["authorization"]).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
				"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
				"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
		expect(headers["host"]).toBeUndefined();
	});

	it("signs a PUT with a payload hash and a special character in the key", async () => {
		const headers = await signHeaders(creds, {
			method: "PUT",
			url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
			headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
			payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
			date,
		});
		expect(headers["authorization"]).toContain(
			"Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
		);
	});

	it("creates a presigned URL", async () => {
		const url = await presignUrl(
			creds,
			"GET",
			new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
			86400,
			date,
		);
		expect(url).toBe(
			"https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
				"&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
				"&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
				"&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
		);
	});

	it("encodes like S3 expects", () => {
		expect(uriEncode("a b/ä+c", true)).toBe("a%20b/%C3%A4%2Bc");
		expect(uriEncode("a/b")).toBe("a%2Fb");
	});
});
