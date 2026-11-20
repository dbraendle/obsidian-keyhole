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

describe("mobile toolbar", () => {
	it("places the upload button after the paper clip", async () => {
		const { placeAfterAttach, isPlacedAfterAttach } = await import("../src/toolbar");
		const base = ["editor:undo", "editor:attach-file", "editor:set-heading", "keyhole:upload-files"];
		const placed = placeAfterAttach(base);
		expect(placed).toEqual(["editor:undo", "editor:attach-file", "keyhole:upload-files", "editor:set-heading"]);
		expect(isPlacedAfterAttach(base)).toBe(false);
		expect(isPlacedAfterAttach(placed)).toBe(true);
		expect(placeAfterAttach(["editor:undo"])).toEqual(["keyhole:upload-files", "editor:undo"]);
	});
});

describe("image sizing", () => {
	it("fits the longest edge", async () => {
		const { fitWithin, renamed, canOptimize } = await import("../src/image");
		expect(fitWithin(1179, 2556, 2560)).toEqual({ width: 1179, height: 2556 });
		expect(fitWithin(4032, 3024, 2560)).toEqual({ width: 2560, height: 1920 });
		expect(renamed("IMG_6271.PNG", "webp")).toBe("IMG_6271.webp");
		expect(canOptimize("a.gif")).toBe(false);
		expect(canOptimize("a.svg")).toBe(false);
		expect(canOptimize("IMG_1.HEIC")).toBe(true);
	});
});

describe("moving local attachments", () => {
	it("keeps sizes and rewrites embeds", async () => {
		const { sizeOf, keyholeEmbed, applyReplacements, isAttachment } = await import("../src/migrate-rules");
		expect(sizeOf("![[photo.jpg|300]]")).toBe("300");
		expect(sizeOf("![[photo.jpg|300x200]]")).toBe("300x200");
		expect(sizeOf("![[photo.jpg|a caption]]")).toBe("");
		expect(sizeOf("![photo|250](_attachments/photo.jpg)")).toBe("250");
		expect(sizeOf("![[doc.pdf#page=2]]")).toBe("");
		expect(isAttachment("md")).toBe(false);
		expect(isAttachment("PDF")).toBe(true);
		const ref = { alias: "main", key: "notes/2026/11/0123456789abcdef-photo.webp" };
		expect(keyholeEmbed("photo.webp", "300", ref)).toBe("![photo.webp|300](keyhole://main/notes/2026/11/0123456789abcdef-photo.webp)");
		const text = "A ![[a.png]] B ![[b.png|200]] C";
		const out = applyReplacements(text, [
			{ start: 2, end: 12, original: "![[a.png]]", replacement: "[A]" },
			{ start: 15, end: 29, original: "![[b.png|200]]", replacement: "[B]" },
		]);
		expect(out).toEqual({ text: "A [A] B [B] C", applied: 2 });
		// offsets moved: falls back to searching the original text
		expect(applyReplacements("xx" + text, [{ start: 2, end: 12, original: "![[a.png]]", replacement: "[A]" }]).text).toBe("xxA [A] B ![[b.png|200]] C");
	});
});

describe("unresolved embeds", () => {
	it("recognises attachment-like link paths", async () => {
		const { looksLikeAttachment } = await import("../src/migrate-rules");
		expect(looksLikeAttachment("Screenshot iPhone.png")).toBe(true);
		expect(looksLikeAttachment("folder/doc.pdf")).toBe(true);
		expect(looksLikeAttachment("Some note")).toBe(false);
		expect(looksLikeAttachment("Some note.md")).toBe(false);
	});
});
