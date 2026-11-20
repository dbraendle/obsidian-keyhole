import { describe, expect, it } from "vitest";
import { pickEvictions } from "../src/cache";
import { kindOf, mimeOf, extensionForMime } from "../src/mime";
import { nameFor, shouldUpload } from "../src/upload-rules";
import { DEFAULT_SETTINGS } from "../src/settings";
import { signKey as pluginSign } from "../src/storage/keyhole-sign";
import { signKey as serverSign } from "../server/src/sign";

describe("signed URLs", () => {
	it("plugin and server compute the same signature", async () => {
		const token = "t".repeat(64);
		expect(await pluginSign(token, "GET", "2026/11/a-b.mp4", 1_800_000_000)).toBe(
			serverSign(token, "GET", "2026/11/a-b.mp4", 1_800_000_000),
		);
	});
});

describe("cache eviction", () => {
	it("evicts oldest first until it fits", () => {
		const entries = [
			{ id: "a", size: 50 },
			{ id: "b", size: 30 },
			{ id: "c", size: 40 },
		];
		expect(pickEvictions(entries, 100)).toEqual(["a"]);
		expect(pickEvictions(entries, 10)).toEqual(["a", "b", "c"]);
		expect(pickEvictions(entries, 200)).toEqual([]);
	});
});

describe("media types", () => {
	it("classifies by extension", () => {
		expect(kindOf("a/b.JPG")).toBe("image");
		expect(kindOf("x.mp4")).toBe("video");
		expect(kindOf("x.pdf")).toBe("pdf");
		expect(kindOf("x.zip")).toBe("file");
		expect(mimeOf("x.zip")).toBe("application/octet-stream");
		expect(extensionForMime("image/jpeg")).toBe("jpg");
	});
});

describe("upload rules", () => {
	const s = { ...DEFAULT_SETTINGS, maxUploadMB: 1 };
	it("respects scope and size", () => {
		expect(shouldUpload({ name: "a.zip", type: "", size: 10 }, s)).toBe(true);
		expect(shouldUpload({ name: "a.zip", type: "", size: 10 }, { ...s, uploadScope: "media" })).toBe(false);
		expect(shouldUpload({ name: "a.pdf", type: "", size: 10 }, { ...s, uploadScope: "images" })).toBe(false);
		expect(shouldUpload({ name: "a.png", type: "", size: 2 * 1024 * 1024 }, s)).toBe(false);
		expect(shouldUpload({ name: "a.png", type: "", size: 0 }, s)).toBe(false);
	});
	it("names pasted images", () => {
		const now = new Date("2026-11-20T13:45:07Z");
		expect(nameFor({ name: "image.png", type: "image/png" }, now)).toBe("Pasted image 20261120134507.png");
		expect(nameFor({ name: "holiday.jpg", type: "image/jpeg" }, now)).toBe("holiday.jpg");
	});
});

describe("runLimited", () => {
	it("never runs more than the limit at once and processes everything", async () => {
		const { runLimited } = await import("../src/upload-rules");
		let running = 0;
		let peak = 0;
		const done: number[] = [];
		await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 5));
			done.push(n);
			running--;
		});
		expect(peak).toBe(3);
		expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});
});
