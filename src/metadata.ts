/**
 * Metadata in images: reading the EXIF block, removing the location, removing
 * everything. Pure byte work without the DOM, so it runs (and is tested) anywhere.
 *
 * JPEG and PNG are edited without touching the picture itself. In other containers
 * (HEIC, AVIF, WebP, TIFF) the location is blanked in place, which never moves a
 * byte and therefore cannot break the file.
 */

export type MetadataMode = "keep" | "no-location" | "strip";

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;
const TAG_MAKER_NOTE = 0x927c;
/** Tags that point at picture data outside the block (strips, embedded thumbnails). */
const DANGLING = new Set([0x0111, 0x0117, 0x0201, 0x0202]);
/** An EXIF block has to fit into one JPEG segment. */
const MAX_EXIF_BYTES = 65000;
const MAX_ENTRIES = 512;

interface Entry {
	tag: number;
	type: number;
	count: number;
	data: Uint8Array;
}

/** The parts of an EXIF block Keyhole carries over to a re-encoded picture. */
export interface ExifData {
	little: boolean;
	ifd0: Entry[];
	exif: Entry[] | null;
	interop: Entry[] | null;
	gps: Entry[] | null;
}

function text(value: string): Uint8Array {
	return Uint8Array.from(value, (c) => c.charCodeAt(0));
}

const EXIF_HEADER = text("Exif\0\0");
const XMP_OPEN = text("<x:xmpmeta");
const XMP_CLOSE = text("</x:xmpmeta>");
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, at: number, needle: ArrayLike<number>): boolean {
	if (at < 0 || at + needle.length > bytes.length) return false;
	for (let i = 0; i < needle.length; i++) if (bytes[at + i] !== needle[i]) return false;
	return true;
}

function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
	const first = needle[0] as number;
	let at = from;
	while ((at = bytes.indexOf(first, at)) >= 0) {
		if (startsWith(bytes, at, needle)) return at;
		at++;
	}
	return -1;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function viewFrom(bytes: Uint8Array, start: number): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start);
}

export function isJpeg(bytes: Uint8Array): boolean {
	return bytes[0] === 0xff && bytes[1] === 0xd8;
}

export function isPng(bytes: Uint8Array): boolean {
	return startsWith(bytes, 0, PNG_SIGNATURE);
}

function isTiffHeader(bytes: Uint8Array, at: number): boolean {
	return startsWith(bytes, at, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, at, [0x4d, 0x4d, 0x00, 0x2a]);
}

// ---------------------------------------------------------------- TIFF / EXIF

function readIfd(view: DataView, little: boolean, offset: number): Entry[] {
	const count = view.getUint16(offset, little);
	if (count > MAX_ENTRIES) throw new RangeError("not an IFD");
	const entries: Entry[] = [];
	for (let i = 0; i < count; i++) {
		const at = offset + 2 + 12 * i;
		const type = view.getUint16(at + 2, little);
		const n = view.getUint32(at + 4, little);
		const size = (TYPE_SIZE[type] ?? 0) * n;
		if (!size || size > MAX_EXIF_BYTES) continue;
		const dataAt = size <= 4 ? at + 8 : view.getUint32(at + 8, little);
		if (dataAt + size > view.byteLength) continue;
		entries.push({
			tag: view.getUint16(at, little),
			type,
			count: n,
			data: new Uint8Array(view.buffer, view.byteOffset + dataAt, size).slice(),
		});
	}
	return entries;
}

function parseTiff(bytes: Uint8Array, start: number): ExifData | null {
	try {
		if (!isTiffHeader(bytes, start)) return null;
		const view = viewFrom(bytes, start);
		const little = bytes[start] === 0x49;
		const pointer = (entries: Entry[] | null, tag: number): Entry[] | null => {
			const entry = entries?.find((e) => e.tag === tag);
			if (!entry || entry.data.length !== 4) return null;
			try {
				return readIfd(view, little, viewFrom(entry.data, 0).getUint32(0, little));
			} catch {
				return null;
			}
		};
		const ifd0 = readIfd(view, little, view.getUint32(4, little));
		const exif = pointer(ifd0, TAG_EXIF_IFD);
		return { little, ifd0, exif, interop: pointer(exif, TAG_INTEROP_IFD), gps: pointer(ifd0, TAG_GPS_IFD) };
	} catch {
		return null;
	}
}

function ifdBytes(entries: Entry[]): number {
	return 2 + 12 * entries.length + 4 + entries.reduce((sum, e) => sum + (e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);
}

function writeIfd(out: Uint8Array, view: DataView, little: boolean, at: number, entries: Entry[]): void {
	const sorted = [...entries].sort((a, b) => a.tag - b.tag);
	view.setUint16(at, sorted.length, little);
	let cursor = at + 2 + 12 * sorted.length + 4;
	sorted.forEach((entry, i) => {
		const pos = at + 2 + 12 * i;
		view.setUint16(pos, entry.tag, little);
		view.setUint16(pos + 2, entry.type, little);
		view.setUint32(pos + 4, entry.count, little);
		if (entry.data.length <= 4) {
			out.set(entry.data, pos + 8);
		} else {
			view.setUint32(pos + 8, cursor, little);
			out.set(entry.data, cursor);
			cursor += entry.data.length + (entry.data.length % 2);
		}
	});
}

function numberEntry(tag: number, type: 3 | 4, value: number, little: boolean): Entry {
	const data = new Uint8Array(type === 3 ? 2 : 4);
	const view = viewFrom(data, 0);
	if (type === 3) view.setUint16(0, value, little);
	else view.setUint32(0, value, little);
	return { tag, type, count: 1, data };
}

function serialize(data: ExifData, orientation: number, location: boolean, makerNote: boolean): Uint8Array<ArrayBuffer> {
	const { little } = data;
	const ifd0 = data.ifd0
		.filter((e) => e.tag !== TAG_EXIF_IFD && e.tag !== TAG_GPS_IFD && e.tag !== TAG_ORIENTATION && !DANGLING.has(e.tag))
		.concat(numberEntry(TAG_ORIENTATION, 3, orientation, little));
	const exif = data.exif?.filter((e) => e.tag !== TAG_INTEROP_IFD && (makerNote || e.tag !== TAG_MAKER_NOTE)) ?? null;
	const interop = exif ? data.interop : null;
	const gps = location ? data.gps : null;

	// Layout: header, IFD0, Exif IFD, Interop IFD, GPS IFD. Pointers are zero while measuring.
	const withPointers = (exifAt: number, interopAt: number, gpsAt: number) => ({
		ifd0: [...ifd0, ...(exif ? [numberEntry(TAG_EXIF_IFD, 4, exifAt, little)] : []), ...(gps ? [numberEntry(TAG_GPS_IFD, 4, gpsAt, little)] : [])],
		exif: exif ? [...exif, ...(interop ? [numberEntry(TAG_INTEROP_IFD, 4, interopAt, little)] : [])] : null,
	});
	const measured = withPointers(0, 0, 0);
	const exifAt = 8 + ifdBytes(measured.ifd0);
	const interopAt = exifAt + (measured.exif ? ifdBytes(measured.exif) : 0);
	const gpsAt = interopAt + (interop ? ifdBytes(interop) : 0);
	const final = withPointers(exifAt, interopAt, gpsAt);

	const out = new Uint8Array(gpsAt + (gps ? ifdBytes(gps) : 0));
	const view = viewFrom(out, 0);
	out.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
	view.setUint16(2, 42, little);
	view.setUint32(4, 8, little);
	writeIfd(out, view, little, 8, final.ifd0);
	if (final.exif) writeIfd(out, view, little, exifAt, final.exif);
	if (interop) writeIfd(out, view, little, interopAt, interop);
	if (gps) writeIfd(out, view, little, gpsAt, gps);
	return out;
}

/** Where EXIF blocks start in the file: every "Exif\0\0" followed by a TIFF header, a WebP EXIF chunk, or a TIFF file itself. */
function tiffStarts(bytes: Uint8Array): number[] {
	const starts = new Set<number>();
	if (isTiffHeader(bytes, 0)) starts.add(0);
	let at = 0;
	while ((at = indexOf(bytes, EXIF_HEADER, at)) >= 0) {
		if (isTiffHeader(bytes, at + EXIF_HEADER.length)) starts.add(at + EXIF_HEADER.length);
		at += EXIF_HEADER.length;
	}
	// WebP may store the block without the "Exif\0\0" prefix.
	if (startsWith(bytes, 0, text("RIFF")) && startsWith(bytes, 8, text("WEBP"))) {
		const view = viewFrom(bytes, 0);
		let pos = 12;
		while (pos + 8 <= bytes.length) {
			const size = view.getUint32(pos + 4, true);
			if (startsWith(bytes, pos, text("EXIF")) && isTiffHeader(bytes, pos + 8)) starts.add(pos + 8);
			pos += 8 + size + (size % 2);
		}
	}
	return [...starts];
}

/** The EXIF data of a picture, or null if it has none (or none that can be read). */
export function readExif(bytes: Uint8Array): ExifData | null {
	if (isPng(bytes)) {
		for (const chunk of pngChunks(bytes) ?? []) {
			if (chunk.type === "eXIf") return parseTiff(bytes.subarray(chunk.start + 8, chunk.end - 4), 0);
		}
		return null;
	}
	for (const start of tiffStarts(bytes)) {
		const data = parseTiff(bytes, start);
		if (data) return data;
	}
	return null;
}

export function orientationOf(data: ExifData | null): number {
	const entry = data?.ifd0.find((e) => e.tag === TAG_ORIENTATION);
	if (!data || !entry || entry.data.length < 2) return 1;
	const value = viewFrom(entry.data, 0).getUint16(0, data.little);
	return value >= 1 && value <= 8 ? value : 1;
}

/**
 * An EXIF block for a picture that was drawn upright and encoded again: the
 * orientation is reset, thumbnails are dropped, the location only stays if asked for.
 * Null if it cannot be made to fit into a JPEG segment.
 */
export function buildExif(data: ExifData, location: boolean): Uint8Array<ArrayBuffer> | null {
	for (const makerNote of [true, false]) {
		const out = serialize(data, 1, location, makerNote);
		if (out.length <= MAX_EXIF_BYTES) return out;
	}
	return null;
}

/** Zeroes the GPS directory of the EXIF block at `start` and unlinks it. True if there was one. */
function blankGps(bytes: Uint8Array, start: number): boolean {
	try {
		const view = viewFrom(bytes, start);
		const little = bytes[start] === 0x49;
		const ifd0 = view.getUint32(4, little);
		const count0 = view.getUint16(ifd0, little);
		if (count0 > MAX_ENTRIES) return false;
		let entry = -1;
		for (let i = 0; i < count0; i++) {
			if (view.getUint16(ifd0 + 2 + 12 * i, little) === TAG_GPS_IFD) entry = ifd0 + 2 + 12 * i;
		}
		if (entry < 0) return false;
		const zero = (at: number, length: number) => {
			if (at >= 0 && at + length <= view.byteLength) bytes.fill(0, start + at, start + at + length);
		};

		const gps = view.getUint32(entry + 8, little);
		if (gps + 2 <= view.byteLength) {
			const count = Math.min(view.getUint16(gps, little), 64);
			for (let i = 0; i < count; i++) {
				const at = gps + 2 + 12 * i;
				if (at + 12 > view.byteLength) break;
				const size = (TYPE_SIZE[view.getUint16(at + 2, little)] ?? 1) * view.getUint32(at + 4, little);
				if (size > 4 && size <= 4096) zero(view.getUint32(at + 8, little), size);
				zero(at, 12);
			}
			view.setUint16(gps, 0, little);
		}

		// Take the pointer out of IFD0: the entries after it and the next-IFD offset move up.
		const end = ifd0 + 2 + 12 * count0 + 4;
		bytes.copyWithin(start + entry, start + entry + 12, start + end);
		zero(end - 12, 12);
		view.setUint16(ifd0, count0 - 1, little);
		return true;
	} catch {
		return false;
	}
}

/** Overwrites GPS values in XMP packets with spaces. The length stays the same. */
function scrubXmp(bytes: Uint8Array): boolean {
	let changed = false;
	let at = 0;
	while ((at = indexOf(bytes, XMP_OPEN, at)) >= 0) {
		const end = indexOf(bytes, XMP_CLOSE, at);
		if (end < 0) break;
		if (end - at <= 4 * 1024 * 1024) {
			const region = bytes.subarray(at, end);
			let packet = "";
			for (let i = 0; i < region.length; i += 8192) packet += String.fromCharCode(...region.subarray(i, i + 8192));
			const blank = (_all: string, head: string, value: string) => head + " ".repeat(value.length);
			const scrubbed = packet
				.replace(/(exif:GPS\w+\s*=\s*")([^"]*)/g, blank)
				.replace(/(exif:GPS\w+\s*=\s*')([^']*)/g, blank)
				.replace(/(<exif:GPS\w+>)([^<]*)/g, blank);
			if (scrubbed !== packet) {
				for (let i = 0; i < region.length; i++) region[i] = scrubbed.charCodeAt(i);
				changed = true;
			}
		}
		at = end;
	}
	return changed;
}

// ---------------------------------------------------------------- PNG

interface PngChunk {
	type: string;
	start: number;
	end: number;
}

function pngChunks(bytes: Uint8Array): PngChunk[] | null {
	const view = viewFrom(bytes, 0);
	const chunks: PngChunk[] = [];
	let pos = 8;
	while (pos + 12 <= bytes.length) {
		const end = pos + 12 + view.getUint32(pos);
		if (end > bytes.length) return null;
		const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		chunks.push({ type, start: pos, end });
		pos = end;
		if (type === "IEND") break;
	}
	return chunks.length ? chunks : null;
}

function filterPng(bytes: Uint8Array, drop: (type: string, data: Uint8Array) => boolean): Uint8Array {
	const chunks = pngChunks(bytes);
	if (!chunks) return bytes;
	const parts = [bytes.subarray(0, 8)];
	let changed = false;
	for (const chunk of chunks) {
		if (drop(chunk.type, bytes.subarray(chunk.start + 8, chunk.end - 4))) changed = true;
		else parts.push(bytes.subarray(chunk.start, chunk.end));
	}
	const last = chunks[chunks.length - 1] as PngChunk;
	parts.push(bytes.subarray(last.end));
	return changed ? concat(parts) : bytes;
}

const PNG_TEXT = new Set(["tEXt", "zTXt", "iTXt"]);

/** Text chunks that can carry a location: XMP packets and the "Raw profile" blocks some tools write. */
function pngLocationChunk(type: string, data: Uint8Array): boolean {
	if (type === "eXIf") return parseTiff(data, 0)?.gps != null;
	if (!PNG_TEXT.has(type)) return false;
	const keyword = String.fromCharCode(...data.subarray(0, Math.min(data.length, 40)));
	if (keyword.startsWith("Raw profile type")) return true;
	if (!keyword.startsWith("XML:com.adobe.xmp")) return false;
	// Compressed packets cannot be searched here: drop them to be safe.
	return type === "zTXt" || indexOf(data, text("GPS"), 0) >= 0;
}

// ---------------------------------------------------------------- JPEG

interface Segment {
	marker: number;
	start: number;
	end: number;
}

/** The segments before the picture data, and where that data starts. Null if this is not a well-formed JPEG. */
function jpegSegments(bytes: Uint8Array): { segments: Segment[]; rest: number } | null {
	if (!isJpeg(bytes)) return null;
	const segments: Segment[] = [];
	let pos = 2;
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) return null;
		const marker = bytes[pos + 1] as number;
		if (marker === 0xff) {
			pos++;
			continue;
		}
		if (marker === 0xda || marker === 0xd9) break;
		if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			pos += 2;
			continue;
		}
		const length = ((bytes[pos + 2] as number) << 8) | (bytes[pos + 3] as number);
		if (length < 2 || pos + 2 + length > bytes.length) return null;
		segments.push({ marker, start: pos, end: pos + 2 + length });
		pos += 2 + length;
	}
	return { segments, rest: pos };
}

function exifSegment(tiff: Uint8Array): Uint8Array {
	const length = 2 + EXIF_HEADER.length + tiff.length;
	return concat([Uint8Array.of(0xff, 0xe1, length >> 8, length & 0xff), EXIF_HEADER, tiff]);
}

/** Rebuilds the JPEG from the segments `keep` accepts, with an optional EXIF block after the JFIF header. */
function rebuildJpeg(bytes: Uint8Array, keep: (segment: Segment) => boolean, tiff: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
	const parsed = jpegSegments(bytes);
	if (!parsed) return null;
	const kept = parsed.segments.filter(keep);
	const leading = kept.findIndex((s) => s.marker !== 0xe0);
	const head = leading < 0 ? kept.length : leading;
	const part = (s: Segment) => bytes.subarray(s.start, s.end);
	return concat([
		Uint8Array.of(0xff, 0xd8),
		...kept.slice(0, head).map(part),
		...(tiff ? [exifSegment(tiff)] : []),
		...kept.slice(head).map(part),
		bytes.subarray(parsed.rest),
	]);
}

/** Puts an EXIF block into a JPEG that has none (a freshly encoded one). Returns the input if it is not a JPEG. */
export function insertExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array {
	return rebuildJpeg(jpeg, () => true, tiff) ?? jpeg;
}

// ---------------------------------------------------------------- public

/**
 * Removes the location (GPS) from a picture and leaves everything else alone.
 * Returns the same array if there was nothing to remove.
 */
export function removeLocation(input: Uint8Array): Uint8Array {
	if (isPng(input)) return filterPng(input, pngLocationChunk);
	const bytes = input.slice();
	let changed = false;
	for (const start of tiffStarts(bytes)) changed = blankGps(bytes, start) || changed;
	changed = scrubXmp(bytes) || changed;
	return changed ? bytes : input;
}

/**
 * Removes all metadata the format lets us remove without re-encoding: everything in
 * JPEG (the orientation and the colour profile stay, the picture needs them) and PNG.
 * Other formats only lose the location. Returns the same array if nothing changed.
 */
export function stripMetadata(input: Uint8Array): Uint8Array {
	if (isPng(input)) return filterPng(input, (type) => PNG_TEXT.has(type) || type === "eXIf" || type === "tIME");
	if (isJpeg(input)) {
		const parsed = jpegSegments(input);
		const dropped = (s: Segment) => s.marker === 0xe1 || s.marker === 0xed || s.marker === 0xfe;
		if (parsed?.segments.some(dropped)) {
			const exif = readExif(input);
			const orientation = orientationOf(exif);
			const tiff = exif && orientation !== 1 ? serialize({ little: false, ifd0: [], exif: null, interop: null, gps: null }, orientation, false, false) : null;
			const out = rebuildJpeg(input, (s) => !dropped(s), tiff);
			// Pictures appended after the first one (depth, gain maps) may carry their own location.
			if (out) return removeLocation(out);
		}
	}
	return removeLocation(input);
}
