import { loadPdfJs, setIcon } from "obsidian";
import { displayName as fileName, parseUrl, UPLOADING_ALIAS, type KeyholeRef } from "./link";
import { kindOf, type MediaKind } from "./mime";
import type { Resolver } from "./resolver";

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
		this.processTree(doc.body);
	}

	disconnect(): void {
		for (const observer of this.observers) observer.disconnect();
		this.observers.length = 0;
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
			this.showStatus(img, ref, "uploading", "Uploading…");
			return;
		}
		if (ref.alias !== this.storeAlias) {
			this.showStatus(img, ref, "error", `Unknown storage "${ref.alias}"`);
			return;
		}
		const kind = kindOf(ref.key);
		if (kind === "image") void this.renderImage(img, ref, src);
		else this.renderEmbed(img, ref, kind);
	}

	private async renderImage(img: HTMLImageElement, ref: KeyholeRef, src: string): Promise<void> {
		img.addClass("keyhole-loading");
		try {
			const url = await this.resolver.blobUrl(ref);
			// The element may have been reused for another file while we were loading.
			if (img.dataset.keyholeSrc !== src) return;
			img.removeClass("keyhole-loading", "keyhole-hidden");
			img.nextElementSibling?.hasClass("keyhole-status") && img.nextElementSibling.remove();
			img.setAttribute("src", url);
		} catch (err) {
			if (img.dataset.keyholeSrc !== src) return;
			img.removeClass("keyhole-loading");
			this.showStatus(img, ref, "error", messageOf(err));
		}
	}

	/** Places a container next to the (hidden) <img>; Obsidian keeps owning the <img>. */
	private container(img: HTMLImageElement, ref: KeyholeRef, cls: string): HTMLElement | null {
		img.addClass("keyhole-hidden");
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
		img.parentElement?.addClass("keyhole-parent");
		return el;
	}

	private showStatus(img: HTMLImageElement, ref: KeyholeRef, state: "uploading" | "error", text: string): void {
		const el = this.container(img, ref, `keyhole-status-${state}`);
		if (!el) return;
		el.addClass("keyhole-status");
		setIcon(el.createSpan({ cls: "keyhole-status-icon" }), state === "uploading" ? "upload-cloud" : "alert-triangle");
		el.createSpan({ text: state === "uploading" ? `${img.alt || "File"} – ${text}` : `${fileName(ref)}: ${text}` });
		if (state === "error") this.onError(text);
	}

	private renderEmbed(img: HTMLImageElement, ref: KeyholeRef, kind: Exclude<MediaKind, "image">): void {
		const el = this.container(img, ref, `keyhole-${kind}`);
		if (!el) return;
		const width = img.getAttribute("width");
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
			void this.renderPdf(el, ref);
		} else {
			this.renderFileCard(el, ref);
		}
	}

	private renderFileCard(el: HTMLElement, ref: KeyholeRef): void {
		setIcon(el.createSpan({ cls: "keyhole-file-icon" }), "file");
		el.createSpan({ cls: "keyhole-file-name", text: fileName(ref) });
		const button = el.createEl("button", { text: "Download" });
		button.addEventListener("click", () => void this.download(ref, button));
	}

	private async download(ref: KeyholeRef, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.setText("Loading…");
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
			button.disabled = false;
			button.setText("Download");
		}
	}

	private async renderPdf(el: HTMLElement, ref: KeyholeRef): Promise<void> {
		const header = el.createDiv({ cls: "keyhole-pdf-header" });
		setIcon(header.createSpan({ cls: "keyhole-file-icon" }), "file-text");
		header.createSpan({ cls: "keyhole-file-name", text: fileName(ref) });
		const download = header.createEl("button", { text: "Download" });
		download.addEventListener("click", () => void this.download(ref, download));
		const pages = el.createDiv({ cls: "keyhole-pdf-pages" });
		try {
			const [pdfjs, blob] = await Promise.all([loadPdfJs() as Promise<PdfJs>, this.resolver.blob(ref)]);
			const data = await blob.arrayBuffer();
			const doc = await pdfjs.getDocument({ data }).promise;
			const observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					observer.unobserve(entry.target);
					const canvas = entry.target as HTMLCanvasElement;
					void this.renderPdfPage(doc, Number(canvas.dataset.page), canvas, pages.clientWidth);
				}
			});
			for (let n = 1; n <= doc.numPages; n++) {
				const canvas = pages.createEl("canvas", { cls: "keyhole-pdf-page" });
				canvas.dataset.page = String(n);
				observer.observe(canvas);
			}
		} catch (err) {
			this.replaceWithError(el, ref, err);
		}
	}

	private async renderPdfPage(doc: PdfDocument, n: number, canvas: HTMLCanvasElement, width: number): Promise<void> {
		const page = await doc.getPage(n);
		const base = page.getViewport({ scale: 1 });
		const scale = (Math.max(width, 300) / base.width) * (window.devicePixelRatio || 1);
		const viewport = page.getViewport({ scale });
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		const ctx = canvas.getContext("2d");
		if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
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

export function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}
