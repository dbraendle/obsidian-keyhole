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
import { FileActions } from "./files";
import { LocalAttachmentHint } from "./hint";
import { initLanguage, t } from "./i18n";
import { bindingId, checkBinding, hostOf, HTTP_SECRET_ID, originOf, S3_SECRET_ID } from "./secrets";

const MB = 1024 * 1024;
const LINK_RE = /keyhole:\/\/[a-z0-9-]+\/[^\s)\]"'<>]+/gi;

export default class KeyholePlugin extends Plugin {
	settings: KeyholeSettings = { ...DEFAULT_SETTINGS };
	private backend: StorageBackend | null = null;
	private cache!: FileCache;
	private resolver!: Resolver;
	private renderer!: Renderer;
	private lastErrorNotice = 0;
	files!: FileActions;
	private hint: LocalAttachmentHint | null = null;

	async onload(): Promise<void> {
		initLanguage();
		await this.loadSettings();
		this.adoptSecretBindings();

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

		this.files = new FileActions({
			app: this.app,
			settings: () => this.settings,
			backend: () => this.getBackend(),
			resolver: this.resolver,
			renderer: this.renderer,
		});
		const hint = new LocalAttachmentHint(this.app, migrator, () => this.settings);
		this.hint = hint;
		this.registerEvent(this.app.workspace.on("file-open", () => hint.update()));
		this.registerEvent(this.app.workspace.on("layout-change", () => hint.update()));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file === this.app.workspace.getActiveFile()) hint.update();
			}),
		);

		this.addCommand({
			id: "restore-note",
			name: t("command.restoreNote"),
			icon: "hard-drive-download",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.files.restoreNote(file);
				return true;
			},
		});
		this.addCommand({
			id: "restore-vault",
			name: t("command.restoreVault"),
			icon: "hard-drive-download",
			callback: () => void this.files.restoreVault(),
		});
		this.addCommand({
			id: "cleanup",
			name: t("command.cleanup"),
			icon: "brush-cleaning",
			callback: () => this.files.cleanup(),
		});

		this.addSettingTab(new KeyholeSettingTab(this.app, this));

		this.addCommand({
			id: "move-note-attachments",
			name: t("command.moveNote"),
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
						.setTitle(t("menu.moveNote"))
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
		this.registerMarkdownPostProcessor((el) => {
			this.renderer.processTree(el);
			this.hint?.scheduleUpdate();
		});

		this.app.workspace.onLayoutReady(() => {
			// Every window that shows notes: the main one and pop-outs. Not "the active window":
			// when Keyhole is switched on, that is the settings window, which shows no notes.
			const windows = new Set<Window>([this.app.workspace.containerEl.win]);
			this.app.workspace.iterateAllLeaves((leaf) => windows.add(leaf.view.containerEl.win));
			for (const win of windows) this.watchWindow(win);
			hint.update();
			this.registerEvent(this.app.workspace.on("window-open", (_win, win) => this.watchWindow(win)));
			if (Platform.isMobile) this.offerMobileToolbar();
		});

		this.addCommand({
			id: "upload-files",
			name: t("command.upload"),
			icon: "upload-cloud",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!ctx.file) return false;
				if (!checking) uploader.pickAndUpload(editor, ctx.file);
				return true;
			},
		});

		// One tap to pick several files at once, also on phones (add the command to the mobile toolbar too).
		this.addRibbonIcon("upload-cloud", t("menu.upload"), () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file) {
				new Notice(t("notice.openNoteFirst"));
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
						.setTitle(t("menu.upload"))
						.setIcon("upload-cloud")
						.onClick(() => uploader.pickAndUpload(editor, note)),
				);
			}),
		);

		this.addCommand({
			id: "make-note-offline",
			name: t("command.makeOffline"),
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
			name: t("command.clearCache"),
			icon: "trash",
			callback: () => void this.clearCache(),
		});
	}

	private readonly watched = new WeakSet<Window>();

	private watchWindow(win: Window): void {
		if (this.watched.has(win)) return;
		this.watched.add(win);
		this.renderer.observe(win.document);
		this.applyDisplaySettings(win.document);
		this.attachWindow(win);
	}

	/**
	 * Per window: a context menu for Keyhole files, and opening keyhole:// links
	 * (Obsidian hands external links to window.open, which cannot load our scheme).
	 */
	private attachWindow(win: Window): void {
		this.registerDomEvent(
			win.document,
			"contextmenu",
			(evt) => {
				const node = evt.target as Node | null;
				const target = node?.instanceOf(Element) ? node.closest("img.keyhole-target, .keyhole-embed") : null;
				const ref = parseUrl(target?.getAttribute("data-keyhole-src"));
				if (!ref || ref.alias !== this.settings.alias) return;
				evt.preventDefault();
				evt.stopImmediatePropagation();
				this.files.showMenu(evt, ref, this.app.workspace.getActiveFile());
			},
			{ capture: true },
		);

		const original = win.open.bind(win);
		let active = true;
		const patched = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
			const ref = active ? parseUrl(typeof url === "string" ? url : url?.toString()) : null;
			if (ref) {
				this.files.open(ref, this.app.workspace.getActiveFile());
				return null;
			}
			return original(url, target, features);
		};
		win.open = patched;
		this.register(() => {
			// Another plugin may have wrapped window.open after us: then leave the chain
			// alone and only stop acting, instead of cutting its wrapper out.
			active = false;
			if (win.open === patched) win.open = original;
		});
	}

	onunload(): void {
		this.hint?.clear();
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
				secretAccessKey: this.secret(S3_SECRET_ID, s.s3Endpoint, t("storage.secretS3")),
			});
		}
		return new HttpBackend({
			baseUrl: s.httpUrl,
			auth: s.storageType === "keyhole" ? "bearer" : s.httpAuth,
			username: s.httpUsername,
			secret: this.secret(HTTP_SECRET_ID, s.httpUrl, t("storage.secretHttp")),
			keyholeServer: s.storageType === "keyhole",
		});
	}

	/**
	 * Reads a secret from the keychain, but only for the host it was saved for:
	 * the storage address is a (possibly synced) setting, the secret is not.
	 */
	private secret(id: string, url: string, what: string): string {
		const value = this.app.secretStorage.getSecret(id);
		if (!value) throw new StorageError(t("storage.noSecret", { what }));
		const bound = this.app.secretStorage.getSecret(bindingId(id));
		if (checkBinding(bound, url) !== "ok") {
			throw new StorageError(
				bound
					? t("storage.secretOtherHost", { what, host: hostOf(bound) })
					: t("storage.secretUnbound", { what }),
			);
		}
		return value;
	}

	/** Remembers in the keychain which host a secret belongs to. Called when a secret is saved. */
	bindSecret(id: string, url: string): void {
		const origin = originOf(url);
		if (origin) this.app.secretStorage.setSecret(bindingId(id), origin);
	}

	/** Secrets saved by versions before 0.4.6 have no host yet: bind them to the configured one, once. */
	private adoptSecretBindings(): void {
		const s = this.settings;
		for (const [id, url] of [
			[S3_SECRET_ID, s.s3Endpoint],
			[HTTP_SECRET_ID, s.httpUrl],
		] as const) {
			const storage = this.app.secretStorage;
			if (storage.getSecret(id) && !storage.getSecret(bindingId(id))) this.bindSecret(id, url);
		}
	}

	async clearCache(): Promise<void> {
		try {
			await this.cache.clear();
			this.resolver.reset();
			this.renderer.rerenderAll();
			new Notice(t("notice.cacheCleared"));
		} catch (err) {
			new Notice(t("notice.cacheClearFailed", { error: messageOf(err) }));
		}
	}

	private async makeOffline(text: string): Promise<void> {
		const refs = new Map<string, KeyholeRef>();
		for (const match of text.matchAll(LINK_RE)) {
			const ref = parseUrl(match[0]);
			if (ref && ref.alias === this.settings.alias) refs.set(ref.key, ref);
		}
		if (!refs.size) {
			new Notice(t("notice.noKeyholeAttachments"));
			return;
		}
		const notice = new Notice(t("notice.downloading", { count: refs.size }), 0);
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
			t("notice.offlineResult", { cached }) +
				(skipped ? t("notice.offlineTooLarge", { count: skipped }) : "") +
				(failed ? t("notice.offlineFailed", { count: failed }) : "") +
				".",
		);
		window.setTimeout(() => notice.hide(), 6000);
	}

	/** Null if this Obsidian version does not have the (non-public) core settings accessors. */
	private coreConfig(): { get(key: string): unknown; set(key: string, value: unknown): void } | null {
		// Not part of the public API: Vault#getConfig/setConfig hold the core settings.
		const vault = this.app.vault as unknown as {
			getConfig?: (key: string) => unknown;
			setConfig?: (key: string, value: unknown) => void;
		};
		if (typeof vault.getConfig !== "function" || typeof vault.setConfig !== "function") return null;
		return { get: (key) => vault.getConfig?.(key), set: (key, value) => vault.setConfig?.(key, value) };
	}

	private toolbarCommands(config: { get(key: string): unknown }): string[] {
		const value = config.get("mobileToolbarCommands");
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	}

	/** Puts the upload button right after the paper clip in the mobile toolbar. */
	addToMobileToolbar(): void {
		const config = this.coreConfig();
		if (!config) {
			new Notice(t("notice.toolbarUnavailable"));
			return;
		}
		config.set("mobileToolbarCommands", placeAfterAttach(this.toolbarCommands(config)));
		new Notice(t("notice.toolbarAdded"));
	}

	/** Asks once (per vault, synced) whether to place the upload button in the mobile toolbar. */
	private offerMobileToolbar(): void {
		const config = this.coreConfig();
		if (!config || this.settings.toolbarPrompted || isPlacedAfterAttach(this.toolbarCommands(config))) return;
		new ConfirmModal(
			this.app,
			t("toolbar.title"),
			t("toolbar.text"),
			t("toolbar.add"),
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
		new Notice(t("notice.error", { message }));
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
			.addButton((b) => b.setButtonText(t("toolbar.notNow")).onClick(() => this.close()))
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
