import { describe, expect, it } from "vitest";
import {
	buildKey,
	displayName,
	formatUrl,
	isValidKey,
	markdownEmbed,
	normalizePrefix,
	parseUrl,
	safeFileName,
} from "../src/link";

describe("link format", () => {
	it("round-trips", () => {
		const ref = { alias: "main", key: "2026/11/0123456789abcdef-photo.jpg" };
		expect(parseUrl(formatUrl(ref))).toEqual(ref);
	});

	it("rejects unsafe or foreign URLs", () => {
		for (const url of [
			"https://example.com/a.png",
			"keyhole://main",
			"keyhole://main/",
			"keyhole://main/../etc/passwd",
			"keyhole://main/a/%2E%2E/b",
			"keyhole://Main Store/a.png",
			"keyhole://main/.hidden",
			"keyhole://main/a//b.png",
			"keyhole://main/%E0%A4%A",
			null,
		]) {
			expect(parseUrl(url), String(url)).toBeNull();
		}
	});

	it("ignores query and fragment", () => {
		expect(parseUrl("keyhole://main/a.png#x")).toEqual({ alias: "main", key: "a.png" });
	});

	it("builds content-addressed keys", () => {
		const key = buildKey({
			prefix: "/vault//",
			date: new Date("2026-11-20T12:00:00Z"),
			hash: "0123456789abcdef0123456789abcdef",
			fileName: "photo.jpg",
		});
		expect(key).toBe("vault/2026/11/0123456789abcdef-photo.jpg");
		expect(isValidKey(key)).toBe(true);
		expect(displayName({ alias: "main", key })).toBe("photo.jpg");
	});

	it("makes file names safe", () => {
		expect(safeFileName("Über Größe (final).PDF", "bin")).toBe("Uber-Grosse-final.pdf");
		expect(safeFileName("../../etc/passwd", "bin")).toBe("passwd.bin");
		expect(safeFileName("....", "png")).toBe("file.png");
		expect(isValidKey(`2026/11/x-${safeFileName("  .bashrc ", "txt")}`)).toBe(true);
	});

	it("normalizes prefixes", () => {
		expect(normalizePrefix("")).toBe("");
		expect(normalizePrefix("a/../b")).toBe("a/b/");
	});

	it("escapes alt text", () => {
		expect(markdownEmbed("a [b] | c", { alias: "main", key: "k.png" })).toBe("![a b c](keyhole://main/k.png)");
	});
});

describe("findLinks", () => {
	it("finds embeds and plain links with sizes", async () => {
		const { findLinks } = await import("../src/link");
		const text = "A ![photo.webp|300](keyhole://main/2026/11/0123456789abcdef-photo.webp) and [Rechnung.pdf](keyhole://main/x/r.pdf) [web](https://x.y)";
		const found = findLinks(text);
		expect(found.map((f) => [f.embed, f.text, f.size, f.ref.key])).toEqual([
			[true, "photo.webp", "300", "2026/11/0123456789abcdef-photo.webp"],
			[false, "Rechnung.pdf", "", "x/r.pdf"],
		]);
		expect(text.slice(found[1]!.start, found[1]!.end)).toBe("[Rechnung.pdf](keyhole://main/x/r.pdf)");
	});
});
