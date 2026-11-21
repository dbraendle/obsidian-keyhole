import { loadPdfJs, setIcon } from "obsidian";
import { displayName as fileName, parseUrl, UPLOADING_ALIAS, type KeyholeRef } from "./link";
import { kindOf, type MediaKind } from "./mime";
import type { Resolver } from "./resolver";
import { t } from "./i18n";

const SELECTOR = 'img[src^="keyhole:" i]';

/**
 * Finds `<img src="keyhole://…">` wherever Obsidian puts them – Reading view,
 * Live Preview, hover popovers, embeds, Canvas – and swaps in the real file.
 *
 * Obsidian turns `![](keyhole://…)` into an <img> in both views. The browser
 * cannot load the private scheme, so no request leaves the device until this
 * class resolves the reference with the device's credentials.
 */
export class Renderer {
	private readonly observers: MutationObserver[] = [];
	private readonly observedDocs = new Set<Document>();
	private storeAlias = "main";

	constructor(
		private readonly resolver: Resolver,
		private readonly onError: (message: string) => void,
	) {}

	setAlias(alias: string): void {
		this.storeAlias = alias;
	}

	observe(doc: Document): void {
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "attributes") {
					const target = record.target;
					if (target.instanceOf(HTMLImageElement)) this.processImage(target);
					continue;
				}
				record.addedNodes.forEach((node) => {
					if (node.nodeType !== Node.ELEMENT_NODE) return;
					this.processTree(node as Element);
				});
			}
		});
		observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
		this.observers.push(observer);
		this.observedDocs.add(doc);
		this.processTree(doc.body);
	}

	disconnect(): void {
		for (const observer of this.observers) observer.disconnect();
		this.observers.length = 0;
		this.observedDocs.clear();
	}

	/**
	 * Renders every Keyhole embed in the open notes again from scratch, e.g. after the
	 * offline cache was cleared, so the files are fetched from storage once more.
	 */
	rerenderAll(): void {
		for (const doc of this.observedDocs) {
			doc.querySelectorAll<HTMLImageElement>("img.keyhole-target").forEach((img) => {
				const src = img.dataset.keyholeSrc;
				if (!src) return;
				const next = img.nextElementSibling;
				if (next?.instanceOf(HTMLElement) && next.hasClass("keyhole-embed")) next.remove();
				img.show();
				delete img.dataset.keyholeRetried;
				// Setting src fires the MutationObserver, which renders the embed again.
				img.setAttribute("src", src);
			});
		}
	}

	/** Retries every embed that is showing an error, e.g. after the credentials were fixed. */
	retryFailed(): void {
		for (const observer of this.observedDocs) {
			observer.querySelectorAll(".keyhole-embed.keyhole-status-error").forEach((status) => {
				const img = status.previousElementSibling;
				if (!img?.instanceOf(HTMLImageElement)) return;
				const src = img.dataset.keyholeSrc;
				status.remove();
				img.show();
				delete img.dataset.keyholeRetried;
				if (src) img.setAttribute("src", src);
				this.processImage(img);
			});
		}
	}

	processTree(root: Element): void {
		if (root.tagName === "IMG") this.processImage(root as HTMLImageElement);
		root.querySelectorAll<HTMLImageElement>(SELECTOR).forEach((img) => this.processImage(img));
	}

	processImage(img: HTMLImageElement): void {
		const src = img.getAttribute("src");
		const ref = parseUrl(src);
		if (!ref || !src) return;
		img.dataset.keyholeSrc = src;
		img.addClass("keyhole-target");

		if (ref.alias === UPLOADING_ALIAS) {
			this.showStatus(img, ref, "uploading", t("render.uploading"));
			return;
		}
		if (ref.alias !== this.storeAlias) {
			this.showStatus(img, ref, "error", t("render.unknownStorage", { alias: ref.alias }));
			return;
		}
		const kind = kindOf(ref.key);
		if (kind === "image") void this.renderImage(img, ref, src);
		else this.renderEmbed(img, ref, kind);
	}

	private async renderImage(img: HTMLImageElement, ref: KeyholeRef, src: string, retried = false): Promise<void> {
		img.addClass("keyhole-loading");
		try {
			const url = await this.resolver.blobUrl(ref);
			// The element may have been reused for another file while we were loading.
			if (img.dataset.keyholeSrc !== src) return;
			img.removeClass("keyhole-loading");
			img.show();
			img.nextElementSibling?.hasClass("keyhole-status") && img.nextElementSibling.remove();
			// If the cached bytes turn out to be unreadable, drop them and download once more.
			if (!retried) {
				img.addEventListener(
					"error",
					() => {
						if (img.getAttribute("src") !== url || img.dataset.keyholeRetried === src) return;
						img.dataset.keyholeRetried = src;
						void this.resolver.invalidate(ref).then(() => this.renderImage(img, ref, src, true));
					},
					{ once: true },
				);
			}
			img.setAttribute("src", url);
		} catch (err) {
			if (img.dataset.keyholeSrc !== src) return;
			img.removeClass("keyhole-loading");
			this.showStatus(img, ref, "error", messageOf(err));
		}
	}

	/** Places a container next to the (hidden) <img>; Obsidian keeps owning the <img>. */
	private container(img: HTMLImageElement, ref: KeyholeRef, cls: string): HTMLElement | null {
		img.hide();
		const src = img.dataset.keyholeSrc ?? "";
		const next = img.nextElementSibling;
		if (next?.instanceOf(HTMLElement) && next.hasClass("keyhole-embed")) {
			if (next.dataset.keyholeSrc === src && next.hasClass(cls)) return null;
			next.remove();
		}
		const el = createDiv({ cls: ["keyhole-embed", cls] });
		el.dataset.keyholeSrc = src;
		el.setAttr("title", fileName(ref));
		img.insertAdjacentElement("afterend", el);
		// Obsidian wraps embeds in shrink-to-fit containers (.image-wrapper inside .image-embed).
		// Make both full width, or a PDF sizes itself by its pixel width (too wide on iOS).
		const wrapper = img.parentElement;
		wrapper?.addClass("keyhole-parent");
		if (wrapper?.parentElement?.matches(".image-embed, .internal-embed")) wrapper.parentElement.addClass("keyhole-parent");
		return el;
	}

	private showStatus(img: HTMLImageElement, ref: KeyholeRef, state: "uploading" | "error", text: string): void {
		const el = this.container(img, ref, `keyhole-status-${state}`);
		if (!el) return;
		el.addClass("keyhole-status");
		setIcon(el.createSpan({ cls: "keyhole-status-icon" }), state === "uploading" ? "upload-cloud" : "alert-triangle");
		el.createSpan({ text: state === "uploading" ? `${img.alt || t("render.file")} – ${text}` : `${fileName(ref)}: ${text}` });
		if (state === "error") this.onError(text);
	}

	private renderEmbed(img: HTMLImageElement, ref: KeyholeRef, kind: Exclude<MediaKind, "image">): void {
		const el = this.container(img, ref, `keyhole-${kind}`);
		if (!el) return;
		this.fill(el, ref, kind, img.getAttribute("width"), labelOf(img, ref));
	}

	/** Renders any Keyhole file into a container of its own (used by the file viewer). */
	renderStandalone(container: HTMLElement, ref: KeyholeRef): void {
		const kind = kindOf(ref.key);
		const el = container.createDiv({ cls: ["keyhole-embed", `keyhole-${kind}`, "keyhole-standalone"] });
		if (kind === "image") {
			const img = el.createEl("img", { cls: "keyhole-standalone-image", attr: { alt: fileName(ref) } });
			this.resolver
				.blobUrl(ref)
				.then((url) => img.setAttr("src", url))
				.catch((err) => this.replaceWithError(el, ref, err));
			return;
		}
		this.fill(el, ref, kind, null, fileName(ref));
	}

	private fill(
		el: HTMLElement,
		ref: KeyholeRef,
		kind: Exclude<MediaKind, "image">,
		width: string | null,
		label: string,
	): void {
		if (kind === "audio" || kind === "video") {
			const media = el.createEl(kind, { attr: { controls: "", preload: "metadata" } });
			if (kind === "video") {
				media.setAttr("playsinline", "");
				if (width) media.setAttr("width", width);
			}
			this.resolver
				.mediaUrl(ref)
				.then((url) => media.setAttr("src", url))
				.catch((err) => this.replaceWithError(el, ref, err));
		} else if (kind === "pdf") {
			void this.renderPdf(el, ref, label);
		} else {
			this.renderFileCard(el, ref, label);
		}
	}

	private renderFileCard(el: HTMLElement, ref: KeyholeRef, label: string): void {
		setIcon(el.createSpan({ cls: "keyhole-file-icon" }), "file");
		el.createSpan({ cls: "keyhole-file-name", text: label });
		const button = el.createEl("button", { text: t("render.download") });
		button.addEventListener("click", () => void this.download(ref, button));
	}

	async download(ref: KeyholeRef, button?: HTMLButtonElement): Promise<void> {
		if (button) {
			button.disabled = true;
			button.setText(t("render.loading"));
		}
		try {
			const url = await this.resolver.blobUrl(ref);
			const name = fileName(ref);
			const blob = await this.resolver.blob(ref);
			const file = new File([blob], name, { type: blob.type });
			if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
				await navigator.share({ files: [file] });
			} else {
				const a = createEl("a", { attr: { href: url, download: name } });
				a.click();
			}
		} catch (err) {
			this.onError(messageOf(err));
		} finally {
			if (button) {
				button.disabled = false;
				button.setText(t("render.download"));
			}
		}
	}

	private async renderPdf(el: HTMLElement, ref: KeyholeRef, label: string): Promise<void> {
		const header = el.createDiv({ cls: "keyhole-pdf-header" });
		setIcon(header.createSpan({ cls: "keyhole-file-icon" }), "file-text");
		header.createSpan({ cls: "keyhole-file-name", text: label });
		const pageCount = header.createSpan({ cls: "keyhole-pdf-count" });
		const download = header.createEl("button", { text: t("render.download") });
		download.addEventListener("click", () => void this.download(ref, download));
		const pages = el.createDiv({ cls: "keyhole-pdf-pages" });
		const loading = pages.createDiv({ cls: "keyhole-pdf-loading", text: t("render.loading") });
		try {
			const [pdfjs, blob] = await Promise.all([loadPdfJs() as Promise<PdfJs>, this.resolver.blob(ref)]);
			const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
			pageCount.setText(t("render.pages", { count: doc.numPages }));
			loading.remove();
			// Placeholders get the first page's proportions, so nothing jumps while scrolling.
			const first = (await doc.getPage(1)).getViewport({ scale: 1 });
			const ratio = `${first.width} / ${first.height}`;
			const canvases: HTMLCanvasElement[] = [];
			for (let n = 1; n <= doc.numPages; n++) {
				const canvas = pages.createEl("canvas", { cls: "keyhole-pdf-page" });
				canvas.dataset.page = String(n);
				canvas.setCssProps({ "--keyhole-page-ratio": ratio });
				canvases.push(canvas);
			}
			// Render pages close to the visible area; free those far away (phones have little canvas memory).
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const canvas = entry.target as HTMLCanvasElement;
						if (entry.isIntersecting) void this.renderPdfPage(doc, canvas, pages.clientWidth);
						else freePdfPage(canvas);
					}
				},
				{ root: pages, rootMargin: "1200px 0px" },
			);
			canvases.forEach((c) => observer.observe(c));
		} catch (err) {
			this.replaceWithError(el, ref, err);
		}
	}

	private async renderPdfPage(doc: PdfDocument, canvas: HTMLCanvasElement, width: number): Promise<void> {
		if (canvas.dataset.state === "rendered" || canvas.dataset.state === "rendering") return;
		canvas.dataset.state = "rendering";
		try {
			const page = await doc.getPage(Number(canvas.dataset.page));
			const base = page.getViewport({ scale: 1 });
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const viewport = page.getViewport({ scale: (Math.max(width, 300) / base.width) * dpr });
			if (canvas.dataset.state !== "rendering") return; // freed meanwhile
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			canvas.setCssProps({ "--keyhole-page-ratio": `${base.width} / ${base.height}` });
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			await page.render({ canvasContext: ctx, viewport }).promise;
			if (canvas.dataset.state === "rendering") canvas.dataset.state = "rendered";
		} catch {
			delete canvas.dataset.state;
		}
	}

	private replaceWithError(el: HTMLElement, ref: KeyholeRef, err: unknown): void {
		el.empty();
		el.className = "keyhole-embed keyhole-status keyhole-status-error";
		setIcon(el.createSpan({ cls: "keyhole-status-icon" }), "alert-triangle");
		el.createSpan({ text: `${fileName(ref)}: ${messageOf(err)}` });
		this.onError(messageOf(err));
	}
}

interface PdfViewport {
	width: number;
	height: number;
}
interface PdfPage {
	getViewport(opts: { scale: number }): PdfViewport;
	render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}
interface PdfDocument {
	numPages: number;
	getPage(n: number): Promise<PdfPage>;
}
interface PdfJs {
	getDocument(opts: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
}

/** The name people gave the file (alt text without a size suffix), else the name from the key. */
function labelOf(img: HTMLImageElement, ref: KeyholeRef): string {
	const alt = (img.getAttribute("alt") ?? "").replace(/\|\d+(x\d+)?\s*$/, "").trim();
	return alt || fileName(ref);
}

/** Releases a page's pixel memory but keeps its size, so the layout does not move. */
function freePdfPage(canvas: HTMLCanvasElement): void {
	if (!canvas.dataset.state) return;
	delete canvas.dataset.state;
	canvas.width = 0;
	canvas.height = 0;
}

export function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : t("error.unknown");
}
