import { describe, expect, it } from "vitest";
import { buildExif, insertExif, orientationOf, readExif, removeLocation, stripMetadata } from "../src/metadata";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const latin = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** A TIFF block: Make "Apple", Orientation 6, and (optionally) a GPS directory with latitude 48/1 7/1 30/1 N. */
function tiff(little: boolean, gps = true): Uint8Array {
	const out = new Uint8Array(gps ? 110 : 56);
	const v = new DataView(out.buffer);
	out.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
	v.setUint16(2, 42, little);
	v.setUint32(4, 8, little);
	const entry = (at: number, tag: number, type: number, count: number) => {
		v.setUint16(at, tag, little);
		v.setUint16(at + 2, type, little);
		v.setUint32(at + 4, count, little);
	};
	v.setUint16(8, gps ? 3 : 2, little);
	entry(10, 0x010f, 2, 6);
	v.setUint32(18, 50, little);
	entry(22, 0x0112, 3, 1);
	v.setUint16(30, 6, little);
	out.set(ascii("Apple\0"), 50);
	if (gps) {
		entry(34, 0x8825, 4, 1);
		v.setUint32(42, 56, little);
		v.setUint16(56, 2, little);
		entry(58, 1, 2, 2);
		out.set(ascii("N\0"), 66);
		entry(70, 2, 5, 3);
		v.setUint32(78, 86, little);
		[48, 1, 7, 1, 30, 1].forEach((n, i) => v.setUint32(86 + 4 * i, n, little));
	}
	return out;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
	const length = payload.length + 2;
	return concat(Uint8Array.of(0xff, marker, length >> 8, length & 0xff), payload);
}

const XMP = '<x:xmpmeta><rdf:Description exif:GPSLatitude="48,7.5N" dc:title="Lake"><exif:GPSAltitude>431/1</exif:GPSAltitude></rdf:Description></x:xmpmeta>';
const JFIF = segment(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
const DQT = segment(0xdb, Uint8Array.of(0, 1, 2, 3));
const SCAN = concat(segment(0xda, Uint8Array.of(1, 2)), ascii("picture-data"), Uint8Array.of(0xff, 0xd9));

function jpeg(block: Uint8Array | null, extras = true): Uint8Array {
	return concat(
		Uint8Array.of(0xff, 0xd8),
		JFIF,
		...(block ? [segment(0xe1, concat(ascii("Exif\0\0"), block))] : []),
		...(extras ? [segment(0xe1, ascii(`http://ns.adobe.com/xap/1.0/\0${XMP}`)), segment(0xfe, ascii("shot at home"))] : []),
		DQT,
		SCAN,
	);
}

function make(data: ReturnType<typeof readExif>): string {
	return latin(data?.ifd0.find((e) => e.tag === 0x010f)?.data ?? new Uint8Array());
}

describe("readExif", () => {
	for (const little of [true, false]) {
		it(`reads a ${little ? "little" : "big"}-endian block from a JPEG`, () => {
			const data = readExif(jpeg(tiff(little)));
			expect(orientationOf(data)).toBe(6);
			expect(make(data)).toBe("Apple\0");
			expect(data?.gps).toHaveLength(2);
		});
	}

	it("returns null without EXIF and on broken input", () => {
		expect(readExif(jpeg(null))).toBeNull();
		expect(readExif(new Uint8Array())).toBeNull();
		expect(readExif(concat(ascii("Exif\0\0"), tiff(true).subarray(0, 12)))).toBeNull();
		expect(orientationOf(null)).toBe(1);
	});
});

describe("removeLocation", () => {
	for (const little of [true, false]) {
		it(`blanks GPS in place (${little ? "little" : "big"} endian) and keeps the rest`, () => {
			const input = jpeg(tiff(little));
			const before = input.slice();
			const out = removeLocation(input);
			expect(input).toEqual(before);
			expect(out).toHaveLength(input.length);
			const data = readExif(out);
			expect(data?.gps).toBeNull();
			expect(orientationOf(data)).toBe(6);
			expect(make(data)).toBe("Apple\0");
			// The latitude itself is gone, not just unlinked.
			const rational = new Uint8Array(8);
			new DataView(rational.buffer).setUint32(0, 48, little);
			new DataView(rational.buffer).setUint32(4, 1, little);
			expect(latin(out)).not.toContain(latin(rational));
			expect(latin(out)).not.toContain("48,7.5N");
			expect(latin(out)).not.toContain("431/1");
			expect(latin(out)).toContain('dc:title="Lake"');
			expect(latin(out)).toContain("picture-data");
		});
	}

	it("returns the same array when there is no location", () => {
		const input = jpeg(tiff(true, false), false);
		expect(removeLocation(input)).toBe(input);
	});

	it("finds the block in other containers", () => {
		const input = concat(ascii("\0\0\0\x18ftypheic....mdat"), ascii("\0\0\0\x06Exif\0\0"), tiff(false), ascii("coded-picture"));
		const out = removeLocation(input);
		expect(out).toHaveLength(input.length);
		expect(readExif(out)?.gps).toBeNull();
		expect(orientationOf(readExif(out))).toBe(6);
		expect(latin(out)).toContain("coded-picture");
	});

	it("survives truncated blocks", () => {
		const input = concat(ascii("Exif\0\0"), tiff(true).subarray(0, 60));
		expect(() => removeLocation(input)).not.toThrow();
	});
});

describe("stripMetadata", () => {
	it("removes EXIF, XMP and comments from a JPEG but keeps the orientation and the picture", () => {
		const out = stripMetadata(jpeg(tiff(true)));
		const text = latin(out);
		expect(text).not.toContain("Apple");
		expect(text).not.toContain("xmpmeta");
		expect(text).not.toContain("shot at home");
		expect(text).toContain("JFIF");
		expect(latin(out.subarray(out.length - SCAN.length))).toBe(latin(SCAN));
		expect(text).toContain(latin(DQT));
		const data = readExif(out);
		expect(orientationOf(data)).toBe(6);
		expect(data?.ifd0).toHaveLength(1);
		expect(data?.gps).toBeNull();
	});

	it("adds no EXIF when the picture is upright", () => {
		const upright = tiff(true);
		new DataView(upright.buffer).setUint16(30, 1, true);
		expect(readExif(stripMetadata(jpeg(upright)))).toBeNull();
	});

	it("returns the same array when a JPEG has nothing to remove", () => {
		const input = jpeg(null, false);
		expect(stripMetadata(input)).toBe(input);
	});
});

describe("buildExif and insertExif", () => {
	it("carries the block over to a new JPEG, upright, with or without the location", () => {
		const source = readExif(jpeg(tiff(false)));
		if (!source) throw new Error("no EXIF");
		const fresh = jpeg(null, false);

		const kept = buildExif(source, true);
		if (!kept) throw new Error("no block");
		const withLocation = insertExif(fresh, kept);
		const data = readExif(withLocation);
		expect(orientationOf(data)).toBe(1);
		expect(make(data)).toBe("Apple\0");
		expect(data?.gps?.find((e) => e.tag === 2)?.data).toEqual(source.gps?.find((e) => e.tag === 2)?.data);
		// The EXIF segment sits right after the JFIF header.
		expect([...withLocation.subarray(2 + JFIF.length, 4 + JFIF.length)]).toEqual([0xff, 0xe1]);
		expect(latin(withLocation.subarray(6 + JFIF.length, 12 + JFIF.length))).toBe("Exif\0\0");
		expect(latin(withLocation.subarray(withLocation.length - SCAN.length))).toBe(latin(SCAN));

		const dropped = buildExif(source, false);
		if (!dropped) throw new Error("no block");
		const without = readExif(insertExif(fresh, dropped));
		expect(without?.gps).toBeNull();
		expect(make(without)).toBe("Apple\0");
	});

	it("leaves non-JPEG data alone", () => {
		const data = ascii("not a jpeg");
		expect(insertExif(data, tiff(true))).toBe(data);
	});
});

describe("PNG", () => {
	const chunk = (type: string, data: Uint8Array) => {
		const head = new Uint8Array(8);
		new DataView(head.buffer).setUint32(0, data.length);
		head.set(ascii(type), 4);
		return concat(head, data, Uint8Array.of(0, 0, 0, 0));
	};
	const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
	const png = (...chunks: Uint8Array[]) => concat(signature, chunk("IHDR", new Uint8Array(13)), ...chunks, chunk("IDAT", ascii("pixels")), chunk("IEND", new Uint8Array()));
	const comment = chunk("tEXt", ascii("Comment\0made at home"));

	it("drops only the location for no-location", () => {
		const out = removeLocation(png(chunk("eXIf", tiff(true)), comment));
		expect(latin(out)).not.toContain("eXIf");
		expect(latin(out)).toContain("made at home");
		expect(latin(out)).toContain("pixels");
		expect(latin(out).endsWith("IEND\0\0\0\0")).toBe(true);
	});

	it("keeps EXIF without a location and returns the same array", () => {
		const input = png(chunk("eXIf", tiff(true, false)), comment);
		expect(removeLocation(input)).toBe(input);
		expect(orientationOf(readExif(input))).toBe(6);
	});

	it("drops all text and EXIF when stripping", () => {
		const out = stripMetadata(png(chunk("eXIf", tiff(true, false)), comment));
		expect(latin(out)).not.toContain("eXIf");
		expect(latin(out)).not.toContain("made at home");
		expect(latin(out)).toContain("pixels");
	});
});
