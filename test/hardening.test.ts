import { describe, expect, it } from "vitest";
import { isUploadKey } from "../src/link";
import { canvasUsesFile } from "../src/migrate-rules";
import { bindingId, checkBinding, hostOf, originOf } from "../src/secrets";
import { parseKeyholeList } from "../src/storage/listing";

describe("secret bound to its host", () => {
	it("accepts the host the secret was saved for", () => {
		expect(checkBinding("https://files.example.com", "https://files.example.com/f/")).toBe("ok");
		expect(checkBinding("https://files.example.com", " https://FILES.example.com/other/path ")).toBe("ok");
	});

	it("refuses another host, port or scheme", () => {
		expect(checkBinding("https://files.example.com", "https://evil.example.net/f/")).toBe("other-host");
		expect(checkBinding("https://files.example.com", "https://files.example.com:8443/f/")).toBe("other-host");
		expect(checkBinding("https://files.example.com", "http://files.example.com/f/")).toBe("other-host");
		expect(checkBinding("https://files.example.com", "https://files.example.com.evil.net/")).toBe("other-host");
	});

	it("refuses a secret that was never bound", () => {
		expect(checkBinding(null, "https://files.example.com/f/")).toBe("unbound");
	});

	it("leaves invalid addresses to the backend", () => {
		expect(checkBinding(null, "not a url")).toBe("ok");
		expect(originOf("")).toBeNull();
	});

	it("names", () => {
		expect(bindingId("keyhole-s3-secret")).toBe("keyhole-s3-secret-host");
		expect(hostOf("https://files.example.com:8443")).toBe("files.example.com:8443");
		expect(hostOf(null)).toBe("");
	});
});

describe("clean-up only offers Keyhole uploads", () => {
	it("accepts keys built by Keyhole", () => {
		expect(isUploadKey("2026/11/3f2a9c1e0b7d4a55-photo.jpg", "")).toBe(true);
		expect(isUploadKey("my-vault/2026/11/3f2a9c1e0b7d4a55-photo.jpg", "my-vault/")).toBe(true);
	});

	it("rejects other files in the same storage", () => {
		expect(isUploadKey("backups/db.sql", "")).toBe(false);
		expect(isUploadKey("keyhole-connection-test.txt", "")).toBe(false);
		// another vault's folder, seen from a vault without a prefix
		expect(isUploadKey("other-vault/2026/11/3f2a9c1e0b7d4a55-photo.jpg", "")).toBe(false);
		expect(isUploadKey("2026/11/photo.jpg", "")).toBe(false);
		expect(isUploadKey("2026/11/3f2a9c1e0b7d4a55-a/b.jpg", "")).toBe(false);
		expect(isUploadKey("2026/11/../3f2a9c1e0b7d4a55-photo.jpg", "")).toBe(false);
		expect(isUploadKey("2026/11/3f2a9c1e0b7d4a55-photo.jpg", "my-vault/")).toBe(false);
	});
});

describe("Keyhole server listing", () => {
	it("keeps well-formed entries and drops the rest", () => {
		expect(
			parseKeyholeList([
				{ key: "2026/11/a.png", size: 3, lastModified: 5 },
				{ key: 7, size: 1 },
				null,
				"x",
				{ key: "b.png", size: "big" },
			]),
		).toEqual([
			{ key: "2026/11/a.png", size: 3, lastModified: 5 },
			{ key: "b.png", size: 0, lastModified: 0 },
		]);
		expect(parseKeyholeList({ key: "a" })).toEqual([]);
	});
});

describe("attachments used in a canvas", () => {
	const canvas = JSON.stringify({ nodes: [{ type: "file", file: "img/photo.png" }, { type: "text", text: "img/other.png" }] });

	it("finds file nodes by path", () => {
		expect(canvasUsesFile(canvas, "img/photo.png", "photo.png")).toBe(true);
		expect(canvasUsesFile(canvas, "img/other.png", "other.png")).toBe(false);
		expect(canvasUsesFile("", "img/photo.png", "photo.png")).toBe(false);
	});

	it("keeps the file if the canvas cannot be parsed", () => {
		expect(canvasUsesFile("{broken photo.png", "img/photo.png", "photo.png")).toBe(true);
	});
});
