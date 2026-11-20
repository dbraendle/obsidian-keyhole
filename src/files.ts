import { Menu, Modal, Notice, Setting, TFile, type App } from "obsidian";
import { t } from "./i18n";
import { displayName, findLinks, formatUrl, markdownEmbed, normalizePrefix, parseUrl, type KeyholeRef } from "./link";
import { formatBytes } from "./migrate-rules";
import { kindOf } from "./mime";
import { messageOf, type Renderer } from "./render";
import type { Resolver } from "./resolver";
import type { KeyholeSettings } from "./settings";
import { TEST_KEY, type StorageBackend, type StoredObject } from "./storage/backend";

export interface FilesContext {
	app: App;
	settings: () => KeyholeSettings;
	backend: () => StorageBackend;
	resolver: Resolver;
	renderer: Renderer;
}

/** Files uploaded more recently than this are never offered for clean-up: other devices may not have synced the notes that use them yet. */
export const CLEANUP_GRACE_DAYS = 7;

/** Everything you can do with a single Keyhole file: open, copy, download, bring back, delete – plus note- and vault-wide actions. */
export class FileActions {
	constructor(private readonly ctx: FilesContext) {}

	/** Context menu for a Keyhole file shown in a note. */
	showMenu(evt: MouseEvent, ref: KeyholeRef, note: TFile | null): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("files.open")).setIcon("maximize-2").onClick(() => this.open(ref, note)));
		menu.addItem((i) => i.setTitle(t("files.copyLink")).setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addItem((i) =>
			i.setTitle(t("render.download")).setIcon("download").onClick(() => void this.ctx.renderer.download(ref)),
		);
		if (note) {
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle(t("files.restore")).setIcon("hard-drive-download").onClick(() => void this.restore(note, [ref])),
			);
			menu.addItem((i) =>
				i
					.setTitle(t("files.delete"))
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => void this.confirmDelete(ref, note)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	open(ref: KeyholeRef, note: TFile | null): void {
		new FileModal(this.ctx.app, this, this.ctx.renderer, ref, note).open();
	}

	async copyLink(ref: KeyholeRef): Promise<void> {
		await navigator.clipboard.writeText(markdownEmbed(displayName(ref), ref));
		new Notice(t("files.linkCopied"));
	}

	/**
	 * Downloads the given files (or all Keyhole files of the note) back into the
	 * vault as normal attachments and rewrites the links. The copies in the storage stay.
	 */
	async restore(note: TFile, only?: KeyholeRef[]): Promise<number> {
		const { app } = this.ctx;
		const text = await app.vault.cachedRead(note);
		const wanted = only ? new Set(only.map((r) => `${r.alias}/${r.key}`)) : null;
		const alias = this.ctx.settings().alias;
		const links = findLinks(text).filter(
			(l) => l.ref.alias === alias && (!wanted || wanted.has(`${l.ref.alias}/${l.ref.key}`)),
		);
		if (!links.length) return 0;

		const saved = new Map<string, TFile>();
		for (const link of links) {
			if (saved.has(link.ref.key)) continue;
			const data = await this.ctx.backend().get(link.ref.key);
			const path = await app.fileManager.getAvailablePathForAttachment(displayName(link.ref), note.path);
			saved.set(link.ref.key, await app.vault.createBinary(path, data));
		}

		await app.vault.process(note, (current) => {
			// Recompute positions on the current text and replace from the end.
			const now = findLinks(current).filter((l) => saved.has(l.ref.key) && l.ref.alias === alias);
			let out = current;
			for (const l of now.reverse()) {
				const file = saved.get(l.ref.key);
				if (!file) continue;
				const alt = l.embed ? l.size || undefined : l.text && l.text !== file.name ? l.text : undefined;
				const md = app.fileManager.generateMarkdownLink(file, note.path, undefined, alt);
				const link = l.embed && !md.startsWith("!") ? `!${md}` : md;
				out = out.slice(0, l.start) + link + out.slice(l.end);
			}
			return out;
		});
		return saved.size;
	}

	async restoreNote(note: TFile): Promise<void> {
		const notice = new Notice(t("files.restoring"), 0);
		try {
			const count = await this.restore(note);
			notice.setMessage(count ? t("files.restored", { count }) : t("files.noneInNote"));
		} catch (err) {
			notice.setMessage(t("notice.error", { message: messageOf(err) }));
		}
		window.setTimeout(() => notice.hide(), 6000);
	}

	/** All notes that contain Keyhole links. */
	async notesWithLinks(): Promise<TFile[]> {
		const { vault } = this.ctx.app;
		const notes: TFile[] = [];
		for (const file of vault.getMarkdownFiles()) {
			if ((await vault.cachedRead(file)).includes("keyhole://")) notes.push(file);
		}
		return notes;
	}

	async restoreVault(): Promise<void> {
		const notes = await this.notesWithLinks();
		if (!notes.length) {
			new Notice(t("files.noneInVault"));
			return;
		}
		new ConfirmModal(this.ctx.app, t("files.restoreVault.title"), t("files.restoreVault.text", { count: notes.length }), t("files.restoreVault.confirm"), async () => {
			const notice = new Notice(t("files.restoring"), 0);
			let files = 0;
			const failed: string[] = [];
			for (const [i, note] of notes.entries()) {
				notice.setMessage(t("files.restoringProgress", { done: i + 1, count: notes.length }));
				try {
					files += await this.restore(note);
				} catch (err) {
					failed.push(`${note.basename} (${messageOf(err)})`);
				}
			}
			notice.setMessage(
				t("files.restoredVault", { files, notes: notes.length }) + (failed.length ? ` ${t("move.failed", { list: failed.join(", ") })}` : ""),
			);
			window.setTimeout(() => notice.hide(), failed.length ? 15000 : 8000);
		}).open();
	}

	/** Notes (other than `except`) that link to this file. */
	async usedIn(ref: KeyholeRef, except?: TFile): Promise<TFile[]> {
		const url = formatUrl(ref);
		const { vault } = this.ctx.app;
		const out: TFile[] = [];
		for (const file of vault.getMarkdownFiles()) {
			if (file === except) continue;
			if ((await vault.cachedRead(file)).includes(url)) out.push(file);
		}
		return out;
	}

	private async confirmDelete(ref: KeyholeRef, note: TFile): Promise<void> {
		const others = await this.usedIn(ref, note);
		const text =
			t("files.delete.text", { name: displayName(ref) }) +
			(others.length ? ` ${t("files.delete.others", { count: others.length, notes: others.slice(0, 3).map((f) => f.basename).join(", ") })}` : "");
		new ConfirmModal(this.ctx.app, t("files.delete.title"), text, t("files.delete.confirm"), async () => {
			try {
				await this.ctx.backend().delete(ref.key);
				await this.ctx.resolver.invalidate(ref);
				await this.ctx.app.vault.process(note, (current) => {
					let out = current;
					for (const l of findLinks(current).reverse()) {
						if (l.ref.key === ref.key && l.ref.alias === ref.alias) out = out.slice(0, l.start) + out.slice(l.end);
					}
					return out;
				});
				new Notice(t("files.deleted", { name: displayName(ref) }));
			} catch (err) {
				new Notice(t("notice.error", { message: messageOf(err) }));
			}
		}, true).open();
	}

	/** Collects the keys all notes and canvases in this vault refer to. */
	async referencedKeys(): Promise<Set<string>> {
		const { vault } = this.ctx.app;
		const alias = this.ctx.settings().alias;
		const keys = new Set<string>();
		const files = vault.getFiles().filter((f) => f.extension === "md" || f.extension === "canvas");
		for (const file of files) {
			const text = await vault.cachedRead(file);
			for (const m of text.matchAll(/keyhole:\/\/[a-z0-9-]+\/[^\s)\]"'<>]+/gi)) {
				const ref = parseUrl(m[0]);
				if (ref && ref.alias === alias) keys.add(ref.key);
			}
		}
		return keys;
	}

	cleanup(): void {
		new CleanupModal(this.ctx.app, this, this.ctx).open();
	}
}

/** Pure: which stored objects no note refers to (and are old enough to be safe to offer). */
export function findOrphans(
	objects: StoredObject[],
	referenced: Set<string>,
	now: number,
	includeRecent: boolean,
): StoredObject[] {
	const cutoff = now - CLEANUP_GRACE_DAYS * 24 * 3600 * 1000;
	return objects
		.filter((o) => o.key !== TEST_KEY && !o.key.endsWith(`/${TEST_KEY}`) && !referenced.has(o.key))
		.filter((o) => includeRecent || (o.lastModified > 0 && o.lastModified < cutoff))
		.sort((a, b) => b.size - a.size);
}

class FileModal extends Modal {
	constructor(
		app: App,
		private readonly actions: FileActions,
		private readonly renderer: Renderer,
		private readonly ref: KeyholeRef,
		private readonly note: TFile | null,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("keyhole-file-modal");
		this.setTitle(displayName(this.ref));
		this.renderer.renderStandalone(this.contentEl.createDiv({ cls: "keyhole-file-modal-body" }), this.ref);
		const buttons = new Setting(this.contentEl);
		// PDFs and other files bring their own download button.
		const kind = kindOf(this.ref.key);
		if (kind === "image" || kind === "audio" || kind === "video") {
			buttons.addButton((b) => b.setButtonText(t("render.download")).onClick(() => void this.renderer.download(this.ref)));
		}
		buttons.addButton((b) => b.setButtonText(t("files.copyLink")).onClick(() => void this.actions.copyLink(this.ref)));
		if (this.note) {
			const note = this.note;
			buttons.addButton((b) =>
				b.setButtonText(t("files.restore")).onClick(async () => {
					this.close();
					await this.actions.restore(note, [this.ref]);
					new Notice(t("files.restored", { count: 1 }));
				}),
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly text: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void | Promise<void>,
		private readonly danger = false,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl("p", { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.confirmText).onClick(() => {
					this.close();
					void this.onConfirm();
				});
				if (this.danger) b.setDestructive();
				else b.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class CleanupModal extends Modal {
	private objects: StoredObject[] = [];
	private referenced = new Set<string>();
	private includeRecent = false;
	private readonly selected = new Set<string>();

	constructor(
		app: App,
		private readonly actions: FileActions,
		private readonly ctx: FilesContext,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("keyhole-cleanup-modal");
		this.setTitle(t("cleanup.title"));
		this.contentEl.createEl("p", { text: t("cleanup.searching") });
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			const prefix = normalizePrefix(this.ctx.settings().keyPrefix);
			[this.objects, this.referenced] = await Promise.all([
				this.ctx.backend().list(prefix),
				this.actions.referencedKeys(),
			]);
			this.render();
		} catch (err) {
			this.contentEl.empty();
			this.contentEl.createEl("p", { cls: "keyhole-status-error", text: messageOf(err) });
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const orphans = findOrphans(this.objects, this.referenced, Date.now(), this.includeRecent);
		for (const key of [...this.selected]) if (!orphans.some((o) => o.key === key)) this.selected.delete(key);

		contentEl.createEl("p", {
			text: t("cleanup.summary", {
				total: this.objects.length,
				used: this.objects.filter((o) => this.referenced.has(o.key)).length,
				orphans: findOrphans(this.objects, this.referenced, Date.now(), true).length,
			}),
		});
		const note = contentEl.createEl("p", { cls: "setting-item-description", text: t("cleanup.explain", { days: CLEANUP_GRACE_DAYS }) });
		if (!normalizePrefix(this.ctx.settings().keyPrefix)) note.appendText(` ${t("cleanup.noPrefix")}`);

		new Setting(contentEl).setName(t("cleanup.includeRecent", { days: CLEANUP_GRACE_DAYS })).addToggle((tg) =>
			tg.setValue(this.includeRecent).onChange((v) => {
				this.includeRecent = v;
				this.render();
			}),
		);

		if (!orphans.length) {
			const recent = this.includeRecent ? 0 : findOrphans(this.objects, this.referenced, Date.now(), true).length;
			contentEl.createEl("p", {
				text: recent ? t("cleanup.onlyRecent", { count: recent, days: CLEANUP_GRACE_DAYS }) : t("cleanup.nothing"),
			});
			return;
		}

		const list = contentEl.createDiv({ cls: "keyhole-cleanup-list" });
		for (const o of orphans) {
			const row = list.createEl("label", { cls: "keyhole-cleanup-row" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = this.selected.has(o.key);
			box.addEventListener("change", () => {
				if (box.checked) this.selected.add(o.key);
				else this.selected.delete(o.key);
				this.updateButton();
			});
			row.createSpan({ cls: "keyhole-cleanup-name", text: o.key });
			row.createSpan({
				cls: "keyhole-cleanup-meta",
				text: `${formatBytes(o.size)}${o.lastModified ? ` · ${new Date(o.lastModified).toLocaleDateString()}` : ""}`,
			});
		}

		const actions = new Setting(contentEl);
		actions.addButton((b) =>
			b.setButtonText(t("cleanup.selectAll")).onClick(() => {
				orphans.forEach((o) => this.selected.add(o.key));
				this.render();
			}),
		);
		actions.addButton((b) => {
			this.deleteButton = b.buttonEl;
			b.setDestructive().onClick(() => void this.deleteSelected());
		});
		this.updateButton();
	}

	private deleteButton: HTMLButtonElement | null = null;

	private updateButton(): void {
		if (!this.deleteButton) return;
		const bytes = this.objects.filter((o) => this.selected.has(o.key)).reduce((s, o) => s + o.size, 0);
		this.deleteButton.setText(t("cleanup.delete", { count: this.selected.size, size: formatBytes(bytes) }));
		this.deleteButton.disabled = this.selected.size === 0;
	}

	private async deleteSelected(): Promise<void> {
		const keys = [...this.selected];
		if (!keys.length) return;
		new ConfirmModal(this.app, t("cleanup.confirm.title"), t("cleanup.confirm.text", { count: keys.length }), t("files.delete.confirm"), async () => {
			const notice = new Notice(t("cleanup.deleting", { count: keys.length }), 0);
			let deleted = 0;
			const failed: string[] = [];
			for (const key of keys) {
				try {
					await this.ctx.backend().delete(key);
					await this.ctx.resolver.invalidate({ alias: this.ctx.settings().alias, key });
					deleted++;
				} catch (err) {
					failed.push(`${key} (${messageOf(err)})`);
				}
			}
			notice.setMessage(t("cleanup.done", { count: deleted }) + (failed.length ? ` ${t("move.failed", { list: failed.join(", ") })}` : ""));
			window.setTimeout(() => notice.hide(), 8000);
			this.objects = this.objects.filter((o) => !keys.includes(o.key) || failed.some((f) => f.startsWith(o.key)));
			this.selected.clear();
			this.render();
		}, true).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
