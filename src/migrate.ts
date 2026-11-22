import { Notice, TFile, getLinkpath, type App, type EmbedCache } from "obsidian";
import { mimeOf } from "./mime";
import { t } from "./i18n";
import { applyReplacements, canvasUsesFile, formatBytes, isAttachment, keyholeEmbed, looksLikeAttachment, sizeOf, type Replacement } from "./migrate-rules";
import { messageOf } from "./render";
import type { KeyholeSettings } from "./settings";
import type { StoredFile, Uploader } from "./upload";
import { shouldUpload } from "./upload-rules";

/** The file is linked, but no note shows it as an embed: there is nothing to rewrite. */
export class NotEmbeddedError extends Error {}

interface MovePlan {
	file: TFile;
	uses: { note: TFile; embeds: EmbedCache[] }[];
	/** A plain link or a property points at the file too: it must stay in the vault. */
	linkedOtherwise: boolean;
}

export interface MoveAllResult {
	moved: number;
	trashed: number;
	skipped: number;
	failed: string[];
	before: number;
	after: number;
}

export interface MigrateContext {
	app: App;
	settings: () => KeyholeSettings;
	uploader: Uploader;
}

/**
 * Moves the local attachments embedded in a note to Keyhole: uploads them
 * (images shrunk like new uploads), rewrites the embeds to keyhole:// links and
 * then moves the local files to the trash – unless another note still uses them.
 */
export class Migrator {
	constructor(private readonly ctx: MigrateContext) {}

	/** Cheap check from the metadata cache, used to show the menu entry only where it helps. */
	hasLocalAttachments(note: TFile): boolean {
		return this.countLocalAttachments(note) > 0;
	}

	/** Number of distinct local attachments embedded in the note that Keyhole would take. */
	countLocalAttachments(note: TFile): number {
		const { metadataCache } = this.ctx.app;
		const settings = this.ctx.settings();
		const paths = new Set<string>();
		for (const embed of metadataCache.getFileCache(note)?.embeds ?? []) {
			const file = metadataCache.getFirstLinkpathDest(getLinkpath(embed.link), note.path);
			if (!file || !isAttachment(file.extension)) continue;
			if (!shouldUpload({ name: file.name, type: mimeOf(file.name), size: file.stat.size }, settings)) continue;
			paths.add(file.path);
		}
		return paths.size;
	}

	async moveNote(note: TFile): Promise<void> {
		const { app } = this.ctx;
		const settings = this.ctx.settings();
		const embeds = app.metadataCache.getFileCache(note)?.embeds ?? [];

		// Group embeds by the file they point to: a file embedded twice is uploaded once.
		const targets = new Map<string, { file: TFile; embeds: typeof embeds }>();
		let skipped = 0;
		// Embeds of attachments that are not on this device (e.g. not synced yet).
		const missing = new Set<string>();
		for (const embed of embeds) {
			const linkpath = getLinkpath(embed.link);
			const file = app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
			if (!file) {
				if (looksLikeAttachment(linkpath)) missing.add(linkpath);
				continue;
			}
			if (!isAttachment(file.extension)) continue;
			if (!shouldUpload({ name: file.name, type: mimeOf(file.name), size: file.stat.size }, settings)) {
				skipped++;
				continue;
			}
			const entry = targets.get(file.path) ?? { file, embeds: [] };
			entry.embeds.push(embed);
			targets.set(file.path, entry);
		}
		if (!targets.size) {
			new Notice(
				missing.size
					? t("move.onlyMissing", { count: missing.size })
					: skipped
						? t("move.noneMatching", { count: skipped })
						: t("move.none"),
				missing.size ? 10000 : undefined,
			);
			return;
		}

		const notice = new Notice(t("move.start", { count: targets.size }), 0);
		const replacements: Replacement[] = [];
		const moved: { file: TFile; stored: StoredFile }[] = [];
		const failed: string[] = [];
		let done = 0;
		for (const { file, embeds: uses } of targets.values()) {
			try {
				const data = await app.vault.readBinary(file);
				const stored = await this.ctx.uploader.store(new File([data], file.name, { type: mimeOf(file.name) }), file.name);
				for (const embed of uses) {
					replacements.push({
						start: embed.position.start.offset,
						end: embed.position.end.offset,
						original: embed.original,
						replacement: keyholeEmbed(stored.name, sizeOf(embed.original), stored.ref),
					});
				}
				moved.push({ file, stored });
			} catch (err) {
				failed.push(`${file.name} (${messageOf(err)})`);
			}
			notice.setMessage(t("move.progress", { done: ++done, count: targets.size }));
		}

		let applied = 0;
		if (replacements.length) {
			await app.vault.process(note, (text) => {
				const result = applyReplacements(text, replacements);
				applied = result.applied;
				return result.text;
			});
		}

		// Only remove local files whose links were all rewritten and that no other note uses.
		let trashed = 0;
		let kept = 0;
		if (applied === replacements.length && settings.trashMovedAttachments) {
			for (const { file } of moved) {
				if (await this.usedElsewhere(file, note)) {
					kept++;
					continue;
				}
				await app.fileManager.trashFile(file);
				trashed++;
			}
		}

		const before = moved.reduce((sum, m) => sum + m.stored.originalBytes, 0);
		const after = moved.reduce((sum, m) => sum + m.stored.bytes, 0);
		const parts = [t("move.result", { count: moved.length, before: formatBytes(before), after: formatBytes(after) })];
		if (trashed) parts.push(t("move.trashed", { count: trashed }));
		if (kept) parts.push(t("move.kept", { count: kept }));
		if (skipped) parts.push(t("move.skipped", { count: skipped }));
		if (missing.size) parts.push(t("move.missing", { count: missing.size }));
		if (failed.length) parts.push(t("move.failed", { list: failed.join(", ") }));
		if (applied < replacements.length) parts.push(t("move.notRewritten"));
		notice.setMessage(parts.join(" "));
		window.setTimeout(() => notice.hide(), failed.length || missing.size ? 15000 : 8000);
	}

	/**
	 * Moves one local attachment: uploads it once and rewrites its embeds in every
	 * note that shows it. The local file only goes to the trash if nothing links to it
	 * afterwards (a plain link or a canvas keeps it).
	 */
	async moveFile(file: TFile): Promise<{ stored: StoredFile; notes: number; trashed: boolean }> {
		return this.executeMove(this.planMove(file));
	}

	/** Where the file is embedded, read from the link index. Does not change anything. */
	private planMove(file: TFile): MovePlan {
		const { app } = this.ctx;
		const { metadataCache } = app;
		const pointsHere = (link: string, note: TFile) => metadataCache.getFirstLinkpathDest(getLinkpath(link), note.path) === file;
		const uses: MovePlan["uses"] = [];
		let linkedOtherwise = false;
		for (const [source, targets] of Object.entries(metadataCache.resolvedLinks)) {
			if (!((targets[file.path] ?? 0) > 0)) continue;
			const note = app.vault.getAbstractFileByPath(source);
			if (!(note instanceof TFile)) continue;
			const cache = metadataCache.getFileCache(note);
			const embeds = (cache?.embeds ?? []).filter((e) => pointsHere(e.link, note));
			const links = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])];
			if (links.some((l) => pointsHere(l.link, note))) linkedOtherwise = true;
			if (embeds.length) uses.push({ note, embeds });
		}
		return { file, uses, linkedOtherwise };
	}

	private async executeMove({ file, uses, linkedOtherwise }: MovePlan): Promise<{ stored: StoredFile; notes: number; trashed: boolean }> {
		const { app } = this.ctx;
		if (!uses.length) throw new NotEmbeddedError(t("overview.notEmbedded"));

		const data = await app.vault.readBinary(file);
		const stored = await this.ctx.uploader.store(new File([data], file.name, { type: mimeOf(file.name) }), file.name);
		let complete = true;
		for (const { note, embeds } of uses) {
			const replacements: Replacement[] = embeds.map((embed) => ({
				start: embed.position.start.offset,
				end: embed.position.end.offset,
				original: embed.original,
				replacement: keyholeEmbed(stored.name, sizeOf(embed.original), stored.ref),
			}));
			let applied = 0;
			await app.vault.process(note, (text) => {
				const result = applyReplacements(text, replacements);
				applied = result.applied;
				return result.text;
			});
			if (applied < replacements.length) complete = false;
		}

		let trashed = false;
		if (complete && !linkedOtherwise && this.ctx.settings().trashMovedAttachments && !(await this.usedInCanvas(file))) {
			await app.fileManager.trashFile(file);
			trashed = true;
		}
		return { stored, notes: uses.length, trashed };
	}

	/** Local attachments that Keyhole takes (type and size) and that at least one note links to. */
	movable(): TFile[] {
		const { vault, metadataCache } = this.ctx.app;
		const settings = this.ctx.settings();
		const linked = new Set<string>();
		for (const targets of Object.values(metadataCache.resolvedLinks)) for (const path of Object.keys(targets)) linked.add(path);
		return vault
			.getFiles()
			.filter(
				(file) =>
					isAttachment(file.extension) &&
					linked.has(file.path) &&
					shouldUpload({ name: file.name, type: mimeOf(file.name), size: file.stat.size }, settings),
			);
	}

	/** Moves the given attachments one after the other. A failure does not stop the rest. */
	async moveAll(files: TFile[], onProgress: (done: number, total: number) => void): Promise<MoveAllResult> {
		const result: MoveAllResult = { moved: 0, trashed: 0, skipped: 0, failed: [], before: 0, after: 0 };
		// Plan everything first: once notes are rewritten, the link index lags behind for a moment,
		// and a second attachment of the same note would look as if nothing embedded it.
		const plans = files.map((file) => this.planMove(file));
		for (const [i, plan] of plans.entries()) {
			const { file } = plan;
			onProgress(i, files.length);
			try {
				const { stored, trashed } = await this.executeMove(plan);
				result.moved++;
				if (trashed) result.trashed++;
				result.before += stored.originalBytes;
				result.after += stored.bytes;
			} catch (err) {
				if (err instanceof NotEmbeddedError) result.skipped++;
				else result.failed.push(`${file.name} (${messageOf(err)})`);
			}
		}
		onProgress(files.length, files.length);
		return result;
	}

	private async usedElsewhere(file: TFile, note: TFile): Promise<boolean> {
		const { metadataCache } = this.ctx.app;
		const links = metadataCache.resolvedLinks;
		if (Object.entries(links).some(([source, targets]) => source !== note.path && (targets[file.path] ?? 0) > 0)) return true;
		return this.usedInCanvas(file);
	}

	private async usedInCanvas(file: TFile): Promise<boolean> {
		const { vault } = this.ctx.app;
		// Canvases refer to files by path in their JSON; the link index does not cover them.
		for (const canvas of vault.getFiles()) {
			if (canvas.extension !== "canvas") continue;
			if (canvasUsesFile(await vault.cachedRead(canvas), file.path, file.name)) return true;
		}
		return false;
	}
}
