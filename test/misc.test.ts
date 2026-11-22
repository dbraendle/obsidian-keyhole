import { describe, expect, it } from "vitest";
import { pickEvictions } from "../src/cache";
import { kindOf, mimeOf, extensionForMime } from "../src/mime";
import { nameFor, shouldUpload } from "../src/upload-rules";
import { DEFAULT_SETTINGS } from "../src/settings";
import { signKey as pluginSign } from "../src/storage/keyhole-sign";

describe("signed URLs", () => {
	// The same vector is tested in dbraendle/keyhole-server (test/server.test.ts).
	it("match the fixed vector shared with the Keyhole server", async () => {
		expect(await pluginSign("t".repeat(64), "GET", "2026/11/a-b.mp4", 1_800_000_000)).toBe(
			"ee4eae0625e36cfcb6c0ccb6b4440aa4cd0291a0add370a35217717eaf02d0d9",
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
	it("respects the switch per kind and the size", async () => {
		const { kindsForScope } = await import("../src/settings");
		expect(shouldUpload({ name: "a.zip", type: "", size: 10 }, s)).toBe(true);
		const onlyPdf = { ...s, uploadImages: false, uploadAudio: false, uploadVideo: false, uploadOther: false };
		expect(shouldUpload({ name: "a.pdf", type: "", size: 10 }, onlyPdf)).toBe(true);
		for (const name of ["a.png", "a.mp3", "a.mp4", "a.zip"]) expect(shouldUpload({ name, type: "", size: 10 }, onlyPdf)).toBe(false);
		expect(shouldUpload({ name: "a.mp4", type: "", size: 10 }, { ...s, uploadVideo: false })).toBe(false);
		expect(shouldUpload({ name: "a.png", type: "", size: 2 * 1024 * 1024 }, s)).toBe(false);
		expect(shouldUpload({ name: "a.png", type: "", size: 0 }, s)).toBe(false);
		// An old single choice maps to the same behaviour.
		expect(shouldUpload({ name: "a.zip", type: "", size: 10 }, { ...s, ...kindsForScope("media") })).toBe(false);
		expect(shouldUpload({ name: "a.pdf", type: "", size: 10 }, { ...s, ...kindsForScope("media") })).toBe(true);
		expect(shouldUpload({ name: "a.pdf", type: "", size: 10 }, { ...s, ...kindsForScope("images") })).toBe(false);
		expect(shouldUpload({ name: "a.png", type: "", size: 10 }, { ...s, ...kindsForScope("images") })).toBe(true);
		expect(kindsForScope("all")).toEqual({ uploadImages: true, uploadAudio: true, uploadVideo: true, uploadPdf: true, uploadOther: true });
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

describe("storage listings", () => {
	it("parses S3 ListObjectsV2", async () => {
		const { parseS3List } = await import("../src/storage/listing");
		const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
			<Contents><Key>notes/2026/11/a&amp;b.png</Key><LastModified>2026-11-20T13:51:20.718Z</LastModified><Size>7727029</Size></Contents>
			<Contents><Key>notes/x.pdf</Key><LastModified>2026-11-01T00:00:00Z</LastModified><Size>388</Size></Contents>
			<NextContinuationToken>abc==</NextContinuationToken></ListBucketResult>`;
		const page = parseS3List(xml);
		expect(page.objects).toEqual([
			{ key: "notes/2026/11/a&b.png", size: 7727029, lastModified: Date.parse("2026-11-20T13:51:20.718Z") },
			{ key: "notes/x.pdf", size: 388, lastModified: Date.parse("2026-11-01T00:00:00Z") },
		]);
		expect(page.next).toBe("abc==");
	});
	it("parses WebDAV multistatus", async () => {
		const { parseDavList } = await import("../src/storage/listing");
		const xml = `<d:multistatus xmlns:d="DAV:">
			<d:response><d:href>/dav/keyhole/2026/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
			<d:response><d:href>/dav/keyhole/2026/a%20b.png</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Fri, 20 Nov 2026 12:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
		</d:multistatus>`;
		expect(parseDavList(xml)).toEqual([
			{ path: "/dav/keyhole/2026/", collection: true, size: 0, lastModified: 0 },
			{ path: "/dav/keyhole/2026/a b.png", collection: false, size: 12, lastModified: Date.parse("Fri, 20 Nov 2026 12:00:00 GMT") },
		]);
	});
});

describe("mobile toolbar modes", () => {
	const A = "editor:attach-file";
	const K = "keyhole:upload-files";

	it("replaces the paper clip in place and remembers that it did", async () => {
		const { applyToolbarMode, toolbarMode } = await import("../src/toolbar");
		const out = applyToolbarMode(["undo", A, "bold"], "replace", false);
		expect(out).toEqual({ commands: ["undo", K, "bold"], removedAttach: true });
		expect(toolbarMode(out.commands, out.removedAttach)).toBe("replace");
	});

	it("brings the paper clip back when leaving replace, in the same place", async () => {
		const { applyToolbarMode } = await import("../src/toolbar");
		expect(applyToolbarMode(["undo", K, "bold"], "beside", true)).toEqual({ commands: ["undo", A, K, "bold"], removedAttach: false });
		expect(applyToolbarMode(["undo", K, "bold"], "off", true)).toEqual({ commands: ["undo", A, "bold"], removedAttach: false });
	});

	it("never adds a paper clip the user removed themselves", async () => {
		const { applyToolbarMode, toolbarMode } = await import("../src/toolbar");
		expect(applyToolbarMode(["undo", "bold"], "replace", false)).toEqual({ commands: [K, "undo", "bold"], removedAttach: false });
		expect(applyToolbarMode([K, "undo"], "off", false)).toEqual({ commands: ["undo"], removedAttach: false });
		expect(toolbarMode([K, "undo"], false)).toBe("beside");
		expect(toolbarMode(["undo", A], false)).toBe("off");
	});

	it("restoreAttach puts the paper clip where the upload button is and is a no-op otherwise", async () => {
		const { restoreAttach } = await import("../src/toolbar");
		expect(restoreAttach(["undo", K, "bold"])).toEqual(["undo", A, K, "bold"]);
		expect(restoreAttach(["undo"])).toEqual([A, "undo"]);
		expect(restoreAttach([A, K])).toEqual([A, K]);
	});
});

describe("applyReplacements with stale offsets", () => {
	it("still finds an embed after an earlier rewrite moved the text", async () => {
		const { applyReplacements } = await import("../src/migrate-rules");
		// Offsets were computed on the original note; the first embed has been rewritten since.
		const original = "![[a.png]]\n\n![[b.png]]\n";
		const afterFirst = original.replace("![[a.png]]", "![a.webp](keyhole://main/2026/11/x.khe#a.webp)");
		const start = original.indexOf("![[b.png]]");
		const out = applyReplacements(afterFirst, [{ start, end: start + 10, original: "![[b.png]]", replacement: "![b.webp](keyhole://main/2026/11/y.khe#b.webp)" }]);
		expect(out.applied).toBe(1);
		expect(out.text).toBe("![a.webp](keyhole://main/2026/11/x.khe#a.webp)\n\n![b.webp](keyhole://main/2026/11/y.khe#b.webp)\n");
	});
});
