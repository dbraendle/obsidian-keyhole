import { MarkdownView, Notice, TFile, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { sha256Hex } from "./crypto";
import { buildKey, markdownEmbed, safeFileName, UPLOADING_ALIAS, type KeyholeRef } from "./link";
import { extensionForMime, mimeOf } from "./mime";
import { clipboardIsRichText, nameFor, runLimited, shouldUpload, UPLOAD_CONCURRENCY } from "./upload-rules";
import type { Resolver } from "./resolver";
import type { KeyholeSettings } from "./settings";
import type { StorageBackend } from "./storage/backend";
import { messageOf } from "./render";
import { optimizeImage } from "./image";

export interface UploadContext {
	app: App;
	settings: () => KeyholeSettings;
	backend: () => StorageBackend;
	resolver: Resolver;
}

export class Uploader {
	constructor(private readonly ctx: UploadContext) {}

	handlePaste(evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
		if (evt.defaultPrevented || !evt.clipboardData) return;
		if (clipboardIsRichText(evt.clipboardData)) return;
		const files = this.pick(evt.clipboardData.files);
		if (!files.length || !info.file) return;
		evt.preventDefault();
		void this.upload(files, editor, info.file);
	}

	handleDrop(evt: DragEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
		if (evt.defaultPrevented || !evt.dataTransfer) return;
		const files = this.pick(evt.dataTransfer.files);
		if (!files.length || !info.file) return;
		evt.preventDefault();
		void this.upload(files, editor, info.file);
	}

	/** Only take over if every file qualifies; mixed drops stay with Obsidian. */
	private pick(list: FileList): File[] {
		const files = Array.from(list);
		const settings = this.ctx.settings();
		if (!files.length || !files.every((f) => shouldUpload(f, settings))) return [];
		return files;
	}

	/**
	 * Opens the system file picker with multi-select. On iOS and Android this is
	 * the native picker (photo library, camera, files), where you can pick many
	 * files at once – unlike Obsidian's own attachment button, which takes one.
	 */
	pickAndUpload(editor: Editor, note: TFile): void {
		const input = activeDocument.body.createEl("input", {
			cls: "keyhole-file-input",
			attr: { type: "file", multiple: "" },
		});
		const cleanup = () => input.remove();
		input.addEventListener("cancel", cleanup);
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			cleanup();
			const settings = this.ctx.settings();
			const tooLarge = files.filter((f) => f.size > settings.maxUploadMB * 1024 * 1024);
			if (tooLarge.length) new Notice(`Keyhole: skipped ${tooLarge.length} file(s) over ${settings.maxUploadMB} MB.`);
			const ok = files.filter((f) => !tooLarge.includes(f) && f.size > 0);
			if (ok.length) void this.upload(ok, editor, note);
		});
		input.click();
	}

	async upload(files: File[], editor: Editor, note: TFile): Promise<void> {
		const jobs = files.map((file) => {
			const name = nameFor(file);
			const id = Math.random().toString(36).slice(2, 10);
			const placeholder = markdownEmbed(name, { alias: UPLOADING_ALIAS, key: id });
			return { file, name, placeholder };
		});
		// Each embed on its own line, and the cursor below the last one – never next to an image.
		const cursor = editor.getCursor("from");
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const lead = before.trim().length > 0 ? "\n" : "";
		editor.replaceSelection(`${lead}${jobs.map((j) => j.placeholder).join("\n")}\n`);

		// A few at a time: on phones every upload holds the whole file in memory.
		const progress = jobs.length > 1 ? new Notice(`Keyhole: uploading ${jobs.length} files…`, 0) : null;
		let finished = 0;
		await runLimited(jobs, UPLOAD_CONCURRENCY, async (job) => {
			await this.uploadOne(job.file, job.name, job.placeholder, note);
			finished++;
			progress?.setMessage(`Keyhole: uploaded ${finished} of ${jobs.length} files…`);
		});
		if (progress) {
			progress.setMessage(`Keyhole: ${jobs.length} files done.`);
			window.setTimeout(() => progress.hide(), 3000);
		}
	}

	private async uploadOne(original: File, originalName: string, placeholder: string, note: TFile): Promise<void> {
		const settings = this.ctx.settings();
		let data: ArrayBuffer | null = null;
		let file = original;
		let name = originalName;
		try {
			if (settings.optimizeImages) {
				const smaller = await this.optimize(original, originalName);
				if (smaller) {
					file = smaller;
					name = smaller.name;
				}
			}
			data = await file.arrayBuffer();
			const hash = await sha256Hex(data);
			const ref: KeyholeRef = {
				alias: settings.alias,
				key: buildKey({
					prefix: settings.keyPrefix,
					date: new Date(),
					hash,
					fileName: safeFileName(name, extensionForMime(file.type)),
				}),
			};
			await this.ctx.backend().put(ref.key, data, file.type || mimeOf(ref.key));
			await this.ctx.resolver.prime(ref, data);
			await this.replacePlaceholder(note, placeholder, markdownEmbed(name, ref));
		} catch (err) {
			await this.handleFailure(err, name, data, placeholder, note);
		}
	}

	/** One image at a time: decoding a 12-megapixel photo takes a lot of memory on phones. */
	private optimizing: Promise<unknown> = Promise.resolve();

	private optimize(file: File, name: string): Promise<File | null> {
		const settings = this.ctx.settings();
		const run = this.optimizing.then(() =>
			optimizeImage(file, name, { maxEdge: settings.imageMaxEdge, quality: settings.imageQuality / 100 }).catch(
				() => null,
			),
		);
		this.optimizing = run;
		return run;
	}

	private async handleFailure(
		err: unknown,
		name: string,
		data: ArrayBuffer | null,
		placeholder: string,
		note: TFile,
	): Promise<void> {
		const reason = messageOf(err);
		if (data && this.ctx.settings().fallbackToLocal) {
			try {
				const { app } = this.ctx;
				const path = await app.fileManager.getAvailablePathForAttachment(name, note.path);
				const local = await app.vault.createBinary(path, data);
				const link = app.fileManager.generateMarkdownLink(local, note.path);
				await this.replacePlaceholder(note, placeholder, link.startsWith("!") ? link : `!${link}`);
				new Notice(`Keyhole: upload failed (${reason}). Saved "${name}" as a local attachment instead.`, 8000);
				return;
			} catch (localErr) {
				new Notice(`Keyhole: upload failed (${reason}) and saving locally failed too (${messageOf(localErr)}).`, 0);
			}
		} else {
			new Notice(`Keyhole: upload of "${name}" failed: ${reason}`, 8000);
		}
		await this.replacePlaceholder(note, placeholder, "");
	}

	/**
	 * Replaces the placeholder wherever the note currently is: in any open editor
	 * (keeps cursor and undo history intact), otherwise in the file on disk.
	 * If the user deleted the placeholder in the meantime, the link goes to the clipboard.
	 */
	private async replacePlaceholder(note: TFile, placeholder: string, replacement: string): Promise<void> {
		const { app } = this.ctx;
		let replaced = false;
		app.workspace.iterateAllLeaves((leaf) => {
			if (replaced || !(leaf.view instanceof MarkdownView) || leaf.view.file !== note) return;
			const editor = leaf.view.editor;
			const offset = editor.getValue().indexOf(placeholder);
			if (offset < 0) return;
			editor.replaceRange(replacement, editor.offsetToPos(offset), editor.offsetToPos(offset + placeholder.length));
			replaced = true;
		});
		if (replaced) return;
		const file = app.vault.getAbstractFileByPath(note.path);
		if (file instanceof TFile) {
			await app.vault.process(file, (text) => {
				if (!text.includes(placeholder)) return text;
				replaced = true;
				return text.replace(placeholder, () => replacement);
			});
		}
		if (!replaced && replacement) {
			await navigator.clipboard.writeText(replacement).catch(() => undefined);
			new Notice("Keyhole: upload finished, but its placeholder was gone. The link is on your clipboard.", 8000);
		}
	}
}
