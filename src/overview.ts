import { Modal, Notice, Setting, TFile, type App } from "obsidian";
import type { FileActions } from "./files";
import { t } from "./i18n";
import { displayName, isEncryptedKey, normalizePrefix, parseUrl, type KeyholeRef } from "./link";
import type { Migrator } from "./migrate";
import { findUrls, formatBytes, isAttachment } from "./migrate-rules";
import { mimeOf } from "./mime";
import { filterByName, sortLocal, type LocalEntry } from "./overview-rules";
import { messageOf } from "./render";
import type { KeyholeSettings } from "./settings";
import type { StorageBackend } from "./storage/backend";
import { shouldUpload } from "./upload-rules";

export interface OverviewContext {
	app: App;
	settings: () => KeyholeSettings;
	backend: () => StorageBackend;
	migrator: Migrator;
	files: FileActions;
}

interface LocalRow extends LocalEntry {
	file: TFile;
	/** Keyhole takes this kind and size of file (upload settings). */
	accepted: boolean;
}

interface RemoteRow {
	ref: KeyholeRef;
	name: string;
	notes: TFile[];
	size: number | null;
}

/** Rows drawn at once: long lists stay light on phones. */
const PAGE = 100;

type Tab = "local" | "remote";

/**
 * One window for the question "what is where": attachments that live in the vault
 * (and sync to every device) next to the files notes load from the storage. Each
 * file can be moved over or brought back on its own.
 */
export class OverviewModal extends Modal {
	private tab: Tab = "local";
	private local: LocalRow[] = [];
	private remote: RemoteRow[] | null = null;
	private remoteError = "";
	private filter = "";
	private shown = PAGE;
	private busy = false;
	private listEl: HTMLElement | null = null;
	private tabsEl: HTMLElement | null = null;

	constructor(private readonly ctx: OverviewContext) {
		super(ctx.app);
	}

	onOpen(): void {
		this.modalEl.addClass("keyhole-overview-modal");
		this.setTitle(t("overview.title"));
		this.tabsEl = this.contentEl.createDiv({ cls: "keyhole-overview-tabs" });
		const search = this.contentEl.createEl("input", {
			cls: "keyhole-overview-search",
			attr: { type: "search", placeholder: t("overview.search") },
		});
		search.addEventListener("input", () => {
			this.filter = search.value;
			this.shown = PAGE;
			this.renderList();
		});
		this.listEl = this.contentEl.createDiv();
		this.loadLocal();
		this.render();
		void this.loadRemote();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** From the link index Obsidian keeps in memory: no file is read for this. */
	private loadLocal(): void {
		const { vault, metadataCache } = this.ctx.app;
		const settings = this.ctx.settings();
		const notes = new Map<string, number>();
		for (const targets of Object.values(metadataCache.resolvedLinks)) {
			for (const path of Object.keys(targets)) notes.set(path, (notes.get(path) ?? 0) + 1);
		}
		this.local = sortLocal(
			vault
				.getFiles()
				.filter((file) => isAttachment(file.extension))
				.map((file) => ({
					file,
					name: file.name,
					size: file.stat.size,
					notes: notes.get(file.path) ?? 0,
					accepted: shouldUpload({ name: file.name, type: mimeOf(file.name), size: file.stat.size }, settings),
				})),
		);
	}

	private async loadRemote(): Promise<void> {
		const { vault } = this.ctx.app;
		const alias = this.ctx.settings().alias;
		const rows = new Map<string, RemoteRow>();
		try {
			for (const file of vault.getFiles()) {
				if (file.extension !== "md" && file.extension !== "canvas") continue;
				const text = await vault.cachedRead(file);
				if (!text.includes("keyhole://")) continue;
				for (const url of findUrls(text)) {
					const ref = parseUrl(url);
					if (!ref || ref.alias !== alias) continue;
					const row = rows.get(ref.key) ?? { ref, name: displayName(ref), notes: [], size: null };
					if (!row.notes.includes(file)) row.notes.push(file);
					rows.set(ref.key, row);
				}
			}
			this.remote = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
		} catch (err) {
			this.remote = [];
			this.remoteError = messageOf(err);
		}
		this.render();
		// Sizes need one listing of the storage; the overview is useful without them.
		try {
			const sizes = new Map((await this.ctx.backend().list(normalizePrefix(this.ctx.settings().keyPrefix))).map((o) => [o.key, o.size]));
			for (const row of this.remote) row.size = sizes.get(row.ref.key) ?? null;
			this.render();
		} catch {
			// offline or no access: rows stay without a size
		}
	}

	private render(): void {
		this.renderTabs();
		this.renderList();
	}

	private renderTabs(): void {
		const el = this.tabsEl;
		if (!el) return;
		el.empty();
		const localBytes = this.local.reduce((sum, r) => sum + r.size, 0);
		const remoteBytes = this.remote?.every((r) => r.size !== null) ? this.remote.reduce((sum, r) => sum + (r.size ?? 0), 0) : null;
		const labels: Record<Tab, string> = {
			local: t("overview.tab.local", { count: this.local.length, size: formatBytes(localBytes) }),
			remote:
				this.remote === null
					? t("overview.tab.remoteLoading")
					: remoteBytes !== null && this.remote.length
						? t("overview.tab.remoteSized", { count: this.remote.length, size: formatBytes(remoteBytes) })
						: t("overview.tab.remote", { count: this.remote.length }),
		};
		for (const tab of ["local", "remote"] as const) {
			const button = el.createEl("button", { text: labels[tab], cls: tab === this.tab ? "mod-cta" : "" });
			button.addEventListener("click", () => {
				this.tab = tab;
				this.shown = PAGE;
				this.render();
			});
		}
	}

	private renderList(): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		el.createEl("p", { cls: "setting-item-description", text: t(this.tab === "local" ? "overview.intro.local" : "overview.intro.remote") });
		if (this.tab === "local") this.renderRows(el, filterByName(this.local, this.filter), (list, row) => this.localRow(list, row), "overview.empty.local");
		else if (this.remote === null) el.createEl("p", { text: t("overview.loading") });
		else if (this.remoteError) el.createEl("p", { cls: "keyhole-status-error", text: this.remoteError });
		else this.renderRows(el, filterByName(this.remote, this.filter), (list, row) => this.remoteRow(list, row), "overview.empty.remote");
	}

	private renderRows<T>(el: HTMLElement, rows: T[], draw: (list: HTMLElement, row: T) => void, emptyKey: "overview.empty.local" | "overview.empty.remote"): void {
		if (!rows.length) {
			el.createEl("p", { text: t(this.filter ? "overview.empty.filter" : emptyKey) });
			return;
		}
		const list = el.createDiv({ cls: "keyhole-overview-list" });
		for (const row of rows.slice(0, this.shown)) draw(list, row);
		if (rows.length > this.shown) {
			new Setting(el).addButton((b) =>
				b.setButtonText(t("overview.more", { count: Math.min(PAGE, rows.length - this.shown) })).onClick(() => {
					this.shown += PAGE;
					this.renderList();
				}),
			);
		}
	}

	private rowShell(list: HTMLElement, name: string, details: string[]): HTMLElement {
		const row = list.createDiv({ cls: "keyhole-overview-row" });
		const info = row.createDiv({ cls: "keyhole-overview-info" });
		info.createDiv({ cls: "keyhole-overview-name", text: name });
		info.createDiv({ cls: "keyhole-overview-meta", text: details.filter(Boolean).join(" · ") });
		return row.createDiv({ cls: "keyhole-overview-actions" });
	}

	private localRow(list: HTMLElement, row: LocalRow): void {
		const folder = row.file.parent?.path ?? "";
		const reason = !row.accepted ? t("overview.excluded") : row.notes ? "" : t("overview.unused");
		const actions = this.rowShell(list, row.name, [
			formatBytes(row.size),
			folder === "/" ? "" : folder,
			reason || t("overview.usedIn", { count: row.notes }),
		]);
		const button = actions.createEl("button", { text: t("overview.upload") });
		button.disabled = Boolean(reason) || this.busy;
		button.addEventListener("click", () => void this.run(button, () => this.upload(row)));
	}

	private remoteRow(list: HTMLElement, row: RemoteRow): void {
		const notes = row.notes.filter((f) => f.extension === "md");
		const actions = this.rowShell(list, row.name, [
			row.size === null ? "" : formatBytes(row.size),
			isEncryptedKey(row.ref.key) ? t("overview.encrypted") : "",
			t("overview.usedIn", { count: row.notes.length }),
		]);
		const open = actions.createEl("button", { text: t("files.open") });
		open.addEventListener("click", () => this.ctx.files.open(row.ref, null));
		const restore = actions.createEl("button", { text: t("overview.restore") });
		restore.disabled = !notes.length || this.busy;
		restore.addEventListener("click", () => void this.run(restore, () => this.restore(row, notes)));
	}

	/** One action at a time: they rewrite notes. */
	private async run(button: HTMLButtonElement, action: () => Promise<string>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		button.setText(t("overview.working"));
		this.renderBusy();
		try {
			new Notice(await action(), 8000);
		} catch (err) {
			new Notice(t("notice.error", { message: messageOf(err) }), 10000);
		}
		this.busy = false;
		// Obsidian updates its link index a moment after notes change.
		await new Promise((resolve) => window.setTimeout(resolve, 600));
		this.loadLocal();
		this.render();
		void this.loadRemote();
	}

	private renderBusy(): void {
		this.listEl?.querySelectorAll("button").forEach((b) => (b.disabled = true));
	}

	private async upload(row: LocalRow): Promise<string> {
		const result = await this.ctx.migrator.moveFile(row.file);
		return [
			t("overview.moved", { name: row.name, count: result.notes }),
			t(result.trashed ? "overview.moved.trashed" : "overview.moved.kept"),
		].join(" ");
	}

	private async restore(row: RemoteRow, notes: TFile[]): Promise<string> {
		// One local copy, however many notes show the file.
		const saved = new Map<string, TFile>();
		for (const note of notes) await this.ctx.files.restore(note, [row.ref], saved);
		return t("files.restored", { count: saved.size });
	}
}
