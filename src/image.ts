/**
 * Prepares images on the device before upload: shrinks them with the canvas every
 * WebView has (phone screenshots are 16-bit PNGs of 8–10 MB; afterwards they are a
 * few hundred KB) and applies the user's choice about metadata. The two are
 * independent: a picture can keep its size and lose its location, or the other way round.
 */
import { extensionOf } from "./link";
import { buildExif, insertExif, readExif, removeLocation, stripMetadata, type MetadataMode } from "./metadata";

export interface OptimizeOptions {
	/** Longest edge in pixels. */
	maxEdge: number;
	/** 0.5–1 */
	quality: number;
	/** JPEG instead of WebP: the only format we can put the picture's metadata back into. */
	preferJpeg?: boolean;
}

export interface PrepareOptions {
	resize: boolean;
	maxEdge: number;
	quality: number;
	metadata: MetadataMode;
}

/** Formats we re-encode. GIF (animation) and SVG (vector) are left alone. */
const OPTIMIZABLE = new Set(["png", "jpg", "jpeg", "webp", "heic", "heif", "bmp", "avif", "tif", "tiff"]);

export function canOptimize(name: string): boolean {
	return OPTIMIZABLE.has(extensionOf(name));
}

/** Target size for a w×h image so that the longest edge is at most maxEdge. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function renamed(name: string, ext: string): string {
	const dot = name.lastIndexOf(".");
	return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
	const data = ctx.getImageData(0, 0, width, height).data;
	// Sample every 16th pixel: enough to catch transparent areas, cheap on phones.
	for (let i = 3; i < data.length; i += 64) if ((data[i] ?? 255) < 255) return true;
	return false;
}

/**
 * Returns a smaller version of the image, or null to upload the original
 * (unsupported format, cannot be decoded here, or not worth it).
 */
export async function optimizeImage(file: File, name: string, opts: OptimizeOptions): Promise<File | null> {
	if (!canOptimize(name)) return null;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null; // e.g. HEIC on desktop: the browser cannot decode it
	}
	try {
		const size = fitWithin(bitmap.width, bitmap.height, opts.maxEdge);
		const canvas = createEl("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(bitmap, 0, 0, size.width, size.height);

		const mayHaveAlpha = ["png", "webp", "avif", "tif", "tiff"].includes(extensionOf(name));
		const alpha = mayHaveAlpha && hasTransparency(ctx, size.width, size.height);

		// WebP where the platform can encode it (not Safari/iOS), otherwise JPEG – or PNG to keep transparency.
		let blob = opts.preferJpeg && !alpha ? null : await toBlob(canvas, "image/webp", opts.quality);
		if (!blob || blob.type !== "image/webp") {
			blob = alpha ? await toBlob(canvas, "image/png", 1) : await toBlob(canvas, "image/jpeg", opts.quality);
		}
		if (!blob) return null;

		const resized = size.width !== bitmap.width || size.height !== bitmap.height;
		if (!resized && blob.size >= file.size * 0.9) return null;
		if (blob.size >= file.size) return null;
		const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
		return new File([blob], renamed(name, ext), { type: blob.type, lastModified: file.lastModified });
	} finally {
		bitmap.close();
	}
}

/**
 * The file to upload instead of the original, or null to upload the original as it is.
 * Re-encoding drops all metadata, so what the user wants to keep is put back; an
 * original that goes up unchanged in size still gets its metadata treated.
 */
export async function prepareImage(file: File, name: string, opts: PrepareOptions): Promise<File | null> {
	if (!canOptimize(name)) return null;
	if (!opts.resize && opts.metadata === "keep") return null;
	const original = new Uint8Array(await file.arrayBuffer());
	const exif = opts.metadata === "strip" ? null : readExif(original);

	if (opts.resize) {
		const smaller = await optimizeImage(file, name, { maxEdge: opts.maxEdge, quality: opts.quality, preferJpeg: exif !== null });
		if (smaller) {
			const block = exif && smaller.type === "image/jpeg" ? buildExif(exif, opts.metadata === "keep") : null;
			if (!block) return smaller;
			const withExif = insertExif(new Uint8Array(await smaller.arrayBuffer()), block);
			return new File([withExif as Uint8Array<ArrayBuffer>], smaller.name, { type: smaller.type, lastModified: smaller.lastModified });
		}
	}

	if (opts.metadata === "keep") return null;
	const cleaned = opts.metadata === "strip" ? stripMetadata(original) : removeLocation(original);
	if (cleaned === original) return null;
	return new File([cleaned as Uint8Array<ArrayBuffer>], name, { type: file.type, lastModified: file.lastModified });
}
