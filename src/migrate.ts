import { Notice, TFile, getLinkpath, type App } from "obsidian";
import { mimeOf } from "./mime";
import { applyReplacements, formatBytes, isAttachment, keyholeEmbed, sizeOf, type Replacement } from "./migrate-rules";
import { messageOf } from "./render";
import type { KeyholeSettings } from "./settings";
import type { StoredFile, Uploader } from "./upload";
import { shouldUpload } from "./upload-rules";

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
		const { metadataCache } = this.ctx.app;
		return (metadataCache.getFileCache(note)?.embeds ?? []).some((embed) => {
			const file = metadataCache.getFirstLinkpathDest(getLinkpath(embed.link), note.path);
			return file !== null && isAttachment(file.extension);
		});
	}

	async moveNote(note: TFile): Promise<void> {
		const { app } = this.ctx;
		const settings = this.ctx.settings();
		const embeds = app.metadataCache.getFileCache(note)?.embeds ?? [];

		// Group embeds by the file they point to: a file embedded twice is uploaded once.
		const targets = new Map<string, { file: TFile; embeds: typeof embeds }>();
		let skipped = 0;
		for (const embed of embeds) {
			const file = app.metadataCache.getFirstLinkpathDest(getLinkpath(embed.link), note.path);
			if (!file || !isAttachment(file.extension)) continue;
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
				skipped
					? `Keyhole: ${skipped} attachment(s) in this note do not match the upload settings (type or size).`
					: "Keyhole: this note has no local attachments.",
			);
			return;
		}

		const notice = new Notice(`Keyhole: moving ${targets.size} attachment(s)…`, 0);
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
			notice.setMessage(`Keyhole: moving attachments… ${++done} of ${targets.size}`);
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
				if (this.usedElsewhere(file, note)) {
					kept++;
					continue;
				}
				await app.fileManager.trashFile(file);
				trashed++;
			}
		}

		const before = moved.reduce((sum, m) => sum + m.stored.originalBytes, 0);
		const after = moved.reduce((sum, m) => sum + m.stored.bytes, 0);
		const parts = [`Keyhole: moved ${moved.length} attachment(s), ${formatBytes(before)} → ${formatBytes(after)}.`];
		if (trashed) parts.push(`${trashed} local file(s) moved to the trash.`);
		if (kept) parts.push(`${kept} kept because other notes still use them.`);
		if (skipped) parts.push(`${skipped} skipped (type or size).`);
		if (failed.length) parts.push(`Failed: ${failed.join(", ")}.`);
		if (applied < replacements.length) parts.push("Some links could not be rewritten; local files were kept.");
		notice.setMessage(parts.join(" "));
		window.setTimeout(() => notice.hide(), failed.length ? 15000 : 8000);
	}

	private usedElsewhere(file: TFile, note: TFile): boolean {
		const links = this.ctx.app.metadataCache.resolvedLinks;
		return Object.entries(links).some(([source, targets]) => source !== note.path && (targets[file.path] ?? 0) > 0);
	}
}
