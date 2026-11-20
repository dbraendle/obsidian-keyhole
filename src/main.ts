import { MarkdownView, Modal, Notice, Platform, Plugin, Setting, TFile, type App } from "obsidian";
import { isPlacedAfterAttach, placeAfterAttach } from "./toolbar";
import { FileCache } from "./cache";
import { parseUrl, type KeyholeRef } from "./link";
import { Renderer, messageOf } from "./render";
import { Resolver } from "./resolver";
import { DEFAULT_SETTINGS, type KeyholeSettings } from "./settings";
import { KeyholeSettingTab } from "./settings-tab";
import { StorageError, type StorageBackend } from "./storage/backend";
import { S3Backend } from "./storage/s3";
import { HttpBackend } from "./storage/webdav";
import { Uploader } from "./upload";
import { Migrator } from "./migrate";

const MB = 1024 * 1024;
const LINK_RE = /keyhole:\/\/[a-z0-9-]+\/[^\s)\]"'<>]+/gi;

export default class KeyholePlugin extends Plugin {
	settings: KeyholeSettings = { ...DEFAULT_SETTINGS };
	private backend: StorageBackend | null = null;
	private cache!: FileCache;
	private resolver!: Resolver;
	private renderer!: Renderer;
	private lastErrorNotice = 0;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.cache = new FileCache(`keyhole-cache/${this.app.vault.getName()}`);
		this.resolver = new Resolver(
			() => this.getBackend(),
			this.cache,
			() => ({
				cacheEnabled: this.settings.cacheEnabled,
				cacheMaxBytes: this.settings.cacheMaxMB * MB,
				cacheMaxFileBytes: this.settings.cacheMaxFileMB * MB,
				streamLargeMedia: this.settings.streamLargeMedia,
			}),
		);
		this.renderer = new Renderer(this.resolver, (message) => this.reportError(message));
		this.renderer.setAlias(this.settings.alias);

		const uploader = new Uploader({
			app: this.app,
			settings: () => this.settings,
			backend: () => this.getBackend(),
			resolver: this.resolver,
		});

		const migrator = new Migrator({ app: this.app, settings: () => this.settings, uploader });

		this.addSettingTab(new KeyholeSettingTab(this.app, this));

		this.addCommand({
			id: "move-note-attachments",
			name: "Move local attachments of the current note to your storage",
			icon: "cloud-upload",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void migrator.moveNote(file);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md" || !migrator.hasLocalAttachments(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Move attachments to Keyhole")
						.setIcon("cloud-upload")
						// Next to "Rename" and "Move file to…", not at the very bottom.
						.setSection("action")
						.onClick(() => void migrator.moveNote(file)),
				);
			}),
		);

		this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor, info) => uploader.handlePaste(evt, editor, info)));
		this.registerEvent(this.app.workspace.on("editor-drop", (evt, editor, info) => uploader.handleDrop(evt, editor, info)));

		// Reading view renders sections before they are attached; resolve them early.
		this.registerMarkdownPostProcessor((el) => this.renderer.processTree(el));

		this.app.workspace.onLayoutReady(() => {
			this.renderer.observe(activeDocument);
			this.applyDisplaySettings(activeDocument);
			this.registerEvent(
				this.app.workspace.on("window-open", (_win, win) => {
					this.renderer.observe(win.document);
					this.applyDisplaySettings(win.document);
				}),
			);
			if (Platform.isMobile) this.offerMobileToolbar();
		});

		this.addCommand({
			id: "upload-files",
			name: "Upload files",
			icon: "upload-cloud",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!ctx.file) return false;
				if (!checking) uploader.pickAndUpload(editor, ctx.file);
				return true;
			},
		});

		// One tap to pick several files at once, also on phones (add the command to the mobile toolbar too).
		this.addRibbonIcon("upload-cloud", "Upload files to Keyhole", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file) {
				new Notice("Keyhole: open a note first.");
				return;
			}
			uploader.pickAndUpload(view.editor, view.file);
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				const note = info.file;
				if (!note) return;
				menu.addItem((item) =>
					item
						.setTitle("Upload files to Keyhole")
						.setIcon("upload-cloud")
						.onClick(() => uploader.pickAndUpload(editor, note)),
				);
			}),
		);

		this.addCommand({
			id: "make-note-offline",
			name: "Keep attachments of the current note on this device",
			icon: "download-cloud",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) void this.makeOffline(view.getViewData());
				return true;
			},
		});

		this.addCommand({
			id: "clear-cache",
			name: "Clear offline cache on this device",
			icon: "trash",
			callback: () => void this.clearCache(),
		});
	}

	onunload(): void {
		this.app.workspace.iterateAllLeaves((leaf) => leaf.view.containerEl.doc.body.removeClass("keyhole-limit-edit-height"));
		this.renderer?.disconnect();
		this.resolver?.reset();
		this.cache?.close();
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<KeyholeSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	/** Called by the settings tab after every change. */
	onSettingsChanged(): void {
		this.backend = null;
		this.resolver.reset();
		this.renderer.setAlias(this.settings.alias);
		this.renderer.retryFailed();
		this.app.workspace.iterateAllLeaves((leaf) => this.applyDisplaySettings(leaf.view.containerEl.doc));
	}

	/** Display options are CSS: a body class plus a custom property per window. */
	private applyDisplaySettings(doc: Document): void {
		const percent = Math.min(100, Math.max(10, Number(this.settings.editMaxHeightPercent) || 50));
		doc.body.toggleClass("keyhole-limit-edit-height", this.settings.limitEditHeight);
		doc.body.setCssProps({ "--keyhole-edit-max-height": `${percent}vh` });
	}

	getBackend(): StorageBackend {
		this.backend ??= this.createBackend();
		return this.backend;
	}

	/** Builds a backend from the settings and this device's keychain. */
	createBackend(): StorageBackend {
		const s = this.settings;
		if (s.storageType === "s3") {
			return new S3Backend({
				endpoint: s.s3Endpoint,
				region: s.s3Region,
				bucket: s.s3Bucket,
				pathStyle: s.s3PathStyle,
				accessKeyId: s.s3AccessKeyId,
				secretAccessKey: this.secret(s.s3SecretKeyRef, "secret access key"),
			});
		}
		return new HttpBackend({
			baseUrl: s.httpUrl,
			auth: s.storageType === "keyhole" ? "bearer" : s.httpAuth,
			username: s.httpUsername,
			secret: this.secret(s.httpSecretRef, "token or password"),
			keyholeServer: s.storageType === "keyhole",
		});
	}

	private secret(ref: string, what: string): string {
		const value = ref ? this.app.secretStorage.getSecret(ref) : null;
		if (!value) throw new StorageError(`No ${what} on this device yet. Add it in the Keyhole settings.`);
		return value;
	}

	async clearCache(): Promise<void> {
		try {
			await this.cache.clear();
			this.resolver.reset();
			new Notice("Keyhole: offline cache cleared.");
		} catch (err) {
			new Notice(`Keyhole: could not clear the cache (${messageOf(err)}).`);
		}
	}

	private async makeOffline(text: string): Promise<void> {
		const refs = new Map<string, KeyholeRef>();
		for (const match of text.matchAll(LINK_RE)) {
			const ref = parseUrl(match[0]);
			if (ref && ref.alias === this.settings.alias) refs.set(ref.key, ref);
		}
		if (!refs.size) {
			new Notice("Keyhole: this note has no Keyhole attachments.");
			return;
		}
		const notice = new Notice(`Keyhole: downloading ${refs.size} file(s)…`, 0);
		let cached = 0;
		let skipped = 0;
		let failed = 0;
		for (const ref of refs.values()) {
			try {
				const result = await this.resolver.makeOffline(ref);
				if (result === "too-large") skipped++;
				else cached++;
			} catch {
				failed++;
			}
		}
		notice.setMessage(
			`Keyhole: ${cached} file(s) available offline` +
				(skipped ? `, ${skipped} larger than the cache limit` : "") +
				(failed ? `, ${failed} failed` : "") +
				".",
		);
		window.setTimeout(() => notice.hide(), 6000);
	}

	private coreConfig(): { get(key: string): unknown; set(key: string, value: unknown): void } {
		// Not part of the public API: Vault#getConfig/setConfig hold the core settings.
		const vault = this.app.vault as unknown as {
			getConfig(key: string): unknown;
			setConfig(key: string, value: unknown): void;
		};
		return { get: (key) => vault.getConfig(key), set: (key, value) => vault.setConfig(key, value) };
	}

	private toolbarCommands(): string[] {
		const value = this.coreConfig().get("mobileToolbarCommands");
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	}

	/** Puts the upload button right after the paper clip in the mobile toolbar. */
	addToMobileToolbar(): void {
		this.coreConfig().set("mobileToolbarCommands", placeAfterAttach(this.toolbarCommands()));
		new Notice("Keyhole: upload button added to the mobile toolbar, next to the paper clip.");
	}

	/** Asks once (per vault, synced) whether to place the upload button in the mobile toolbar. */
	private offerMobileToolbar(): void {
		if (this.settings.toolbarPrompted || isPlacedAfterAttach(this.toolbarCommands())) return;
		new ConfirmModal(
			this.app,
			"Add the upload button to the toolbar?",
			"Keyhole can put its upload button right next to the paper clip in the toolbar above the keyboard. With it you can pick several photos or files at once.",
			"Add button",
			() => this.addToMobileToolbar(),
		).open();
		this.settings.toolbarPrompted = true;
		void this.saveData(this.settings);
	}

	/** Rendering errors can come in bursts (one per embed); show at most one notice every few seconds. */
	private reportError(message: string): void {
		const now = Date.now();
		if (now - this.lastErrorNotice < 5000) return;
		this.lastErrorNotice = now;
		new Notice(`Keyhole: ${message}`);
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly text: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl("p", { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Not now").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.onConfirm();
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
