import { MarkdownView, setIcon, type App, type TFile } from "obsidian";
import { t } from "./i18n";
import type { Migrator } from "./migrate";
import type { KeyholeSettings } from "./settings";

/**
 * A small bar at the top of a note that still has local attachments, offering to
 * move them – e.g. photos shared into Obsidian from the phone. Nothing happens
 * without a tap; dismissed notes stay quiet until the app restarts.
 */
export class LocalAttachmentHint {
	private readonly dismissed = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly migrator: Migrator,
		private readonly settings: () => KeyholeSettings,
	) {}

	private pending = 0;

	/** Coalesces bursts of events (e.g. every section render in Reading view) into one update. */
	scheduleUpdate(): void {
		window.clearTimeout(this.pending);
		this.pending = window.setTimeout(() => this.update(), 150);
	}

	update(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) this.updateView(leaf.view);
		});
	}

	/**
	 * The bar lives inside the scrolling content, right above the note title – in both
	 * Live Preview / source mode and Reading view – so it scrolls away with the text and
	 * never hides under the floating header on phones.
	 */
	private targets(view: MarkdownView): HTMLElement[] {
		const out: HTMLElement[] = [];
		const source = view.contentEl.querySelector<HTMLElement>(".markdown-source-view .cm-sizer");
		// Reading view rebuilds sections while scrolling; its header block (title, properties) stays.
		const preview = view.contentEl.querySelector<HTMLElement>(".markdown-preview-view .markdown-preview-sizer > .mod-header");
		if (source) out.push(source);
		if (preview) out.push(preview);
		return out;
	}

	private updateView(view: MarkdownView): void {
		const file = view.file;
		const count = file && this.settings().suggestMove && !this.dismissed.has(file.path) ? this.migrator.countLocalAttachments(file) : 0;
		for (const target of this.targets(view)) {
			const existing = target.querySelector(":scope > .keyhole-hint");
			if (!count || !file) {
				existing?.remove();
				continue;
			}
			if (existing?.getAttribute("data-path") === file.path && existing.getAttribute("data-count") === String(count)) continue;
			existing?.remove();
			const bar = this.render(view, file, count);
			// Right below the note title, where properties would start.
			const title = target.querySelector(":scope > .inline-title");
			target.insertBefore(bar, title ? title.nextSibling : target.firstChild);
		}
	}

	private render(view: MarkdownView, file: TFile, count: number): HTMLElement {
		const bar = createDiv({ cls: "keyhole-hint", attr: { "data-path": file.path, "data-count": String(count) } });
		setIcon(bar.createSpan({ cls: "keyhole-hint-icon" }), "cloud-upload");
		bar.createSpan({ cls: "keyhole-hint-text", text: t("hint.text", { count }) });
		const actions = bar.createDiv({ cls: "keyhole-hint-actions" });
		const move = actions.createEl("button", { cls: "mod-cta", text: t("hint.move") });
		move.addEventListener("click", () => {
			this.removeAll(view);
			void this.migrator.moveNote(file).then(() => this.update());
		});
		const close = actions.createEl("button", { cls: "clickable-icon keyhole-hint-close", attr: { "aria-label": t("hint.dismiss") } });
		setIcon(close, "x");
		close.addEventListener("click", () => {
			this.dismissed.add(file.path);
			this.removeAll(view);
		});
		return bar;
	}

	private removeAll(view: MarkdownView): void {
		view.contentEl.querySelectorAll(".keyhole-hint").forEach((el) => el.remove());
	}

	clear(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) this.removeAll(leaf.view);
		});
	}
}
