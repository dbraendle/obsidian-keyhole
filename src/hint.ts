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

	update(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) this.updateView(leaf.view);
		});
	}

	private updateView(view: MarkdownView): void {
		const existing = view.contentEl.querySelector(":scope > .keyhole-hint");
		const file = view.file;
		const count = file && this.settings().suggestMove && !this.dismissed.has(file.path) ? this.migrator.countLocalAttachments(file) : 0;
		if (!count || !file) {
			existing?.remove();
			return;
		}
		if (existing?.getAttribute("data-path") === file.path && existing.getAttribute("data-count") === String(count)) return;
		existing?.remove();
		this.render(view, file, count);
	}

	private render(view: MarkdownView, file: TFile, count: number): void {
		const bar = createDiv({ cls: "keyhole-hint", attr: { "data-path": file.path, "data-count": String(count) } });
		setIcon(bar.createSpan({ cls: "keyhole-hint-icon" }), "cloud-upload");
		bar.createSpan({ cls: "keyhole-hint-text", text: t("hint.text", { count }) });
		const move = bar.createEl("button", { cls: "mod-cta", text: t("hint.move") });
		move.addEventListener("click", () => {
			bar.remove();
			void this.migrator.moveNote(file).then(() => this.update());
		});
		const close = bar.createEl("button", { cls: "clickable-icon keyhole-hint-close", attr: { "aria-label": t("hint.dismiss") } });
		setIcon(close, "x");
		close.addEventListener("click", () => {
			this.dismissed.add(file.path);
			bar.remove();
		});
		view.contentEl.prepend(bar);
	}

	clear(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaf.view.contentEl.querySelector(":scope > .keyhole-hint")?.remove();
		});
	}
}
