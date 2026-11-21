import { MarkdownView, Notice, TFile, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { sha256Hex } from "./crypto";
import { sha256HexOfBlob } from "./sha256";
import { MULTIPART_THRESHOLD_BYTES } from "./storage/multipart";
import { createEncryptor, encryptedSource, objectId } from "./e2e/format";
import { buildEncryptedKey, buildKey, markdownEmbed, safeFileName, UPLOADING_ALIAS, type KeyholeRef } from "./link";
import { blobSource } from "./storage/source";
import { extensionForMime, mimeOf } from "./mime";
import { clipboardIsRichText, nameFor, runLimited, shouldUpload, UPLOAD_CONCURRENCY } from "./upload-rules";
import type { Resolver } from "./resolver";
import type { KeyholeSettings } from "./settings";
import type { StorageBackend } from "./storage/backend";
import { messageOf } from "./render";
import { optimizeImage } from "./image";
import { t } from "./i18n";

export interface UploadContext {
	app: App;
	settings: () => KeyholeSettings;
	backend: () => StorageBackend;
	resolver: Resolver;
	/** The key to encrypt new uploads with, or null if encryption is off. Throws if it is on but the key is missing. */
	encryptionKey: () => Uint8Array<ArrayBuffer> | null;
}

export interface StoredFile {
	ref: KeyholeRef;
	/** File name after optimization (the extension may have changed). */
	name: string;
	bytes: number;
	originalBytes: number;
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
			if (tooLarge.length) new Notice(t("notice.skippedTooLarge", { count: tooLarge.length, max: settings.maxUploadMB }));
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
		const progress = jobs.length > 1 ? new Notice(t("notice.uploadingMany", { count: jobs.length }), 0) : null;
		let finished = 0;
		await runLimited(jobs, UPLOAD_CONCURRENCY, async (job) => {
			await this.uploadOne(job.file, job.name, job.placeholder, note);
			finished++;
			progress?.setMessage(t("notice.uploadedProgress", { done: finished, count: jobs.length }));
		});
		if (progress) {
			progress.setMessage(t("notice.uploadedDone", { count: jobs.length }));
			window.setTimeout(() => progress.hide(), 3000);
		}
	}

	private async uploadOne(original: File, originalName: string, placeholder: string, note: TFile): Promise<void> {
		try {
			const stored = await this.store(original, originalName);
			await this.replacePlaceholder(note, placeholder, markdownEmbed(stored.name, stored.ref));
		} catch (err) {
			const data = await original.arrayBuffer().catch(() => null);
			await this.handleFailure(err, originalName, data, placeholder, note);
		}
	}

	/**
	 * Shrinks the file if it is an image (and the setting is on), uploads it under its
	 * content-addressed key and keeps a copy in the cache. Used by paste/drop/picker
	 * and by the migration of local attachments.
	 */
	async store(original: File, originalName: string): Promise<StoredFile> {
		const settings = this.ctx.settings();
		let file = original;
		let name = originalName;
		if (settings.optimizeImages) {
			const smaller = await this.optimize(original, originalName);
			if (smaller) {
				file = smaller;
				name = smaller.name;
			}
		}
		const backend = this.ctx.backend();
		const vaultKey = this.ctx.encryptionKey();
		const safeName = safeFileName(name, extensionForMime(file.type));
		// Large files go up in parts where the storage can do that, so they never
		// have to fit into memory as a whole (phones run out of it).
		const large = file.size > MULTIPART_THRESHOLD_BYTES && backend.putLarge !== undefined;
		const hash = large ? await sha256HexOfBlob(file) : await sha256Hex(await file.arrayBuffer());
		const date = new Date();

		let ref: KeyholeRef;
		let source = blobSource(file);
		let contentType: string;
		if (vaultKey) {
			// Encrypted: the key says nothing about the file; its name stays in the link.
			ref = {
				alias: settings.alias,
				key: buildEncryptedKey({ prefix: settings.keyPrefix, date, id: await objectId(vaultKey, hash) }),
				name: safeName,
			};
			source = encryptedSource(await createEncryptor(vaultKey), file);
			contentType = "application/octet-stream";
		} else {
			ref = { alias: settings.alias, key: buildKey({ prefix: settings.keyPrefix, date, hash, fileName: safeName }) };
			contentType = file.type || mimeOf(ref.key);
		}

		if (large && backend.putLarge) {
			await backend.putLarge(ref.key, source, contentType);
			await this.ctx.resolver.prime(ref, file);
		} else {
			const stored = await source.read(0, source.size);
			await backend.put(ref.key, stored, contentType);
			await this.ctx.resolver.prime(ref, file, stored);
		}
		return { ref, name, bytes: file.size, originalBytes: original.size };
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
				new Notice(t("notice.uploadFailedLocal", { reason, name }), 8000);
				return;
			} catch (localErr) {
				new Notice(t("notice.uploadFailedLocalFailed", { reason, error: messageOf(localErr) }), 0);
			}
		} else {
			new Notice(t("notice.uploadFailed", { name, reason }), 8000);
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
			new Notice(t("notice.placeholderGone"), 8000);
		}
	}
}
