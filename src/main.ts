import { MarkdownView, Modal, Notice, Platform, Plugin, Setting, TFile, type App } from "obsidian";
import { OverviewModal } from "./overview";
import { SetupModal, type SetupMode } from "./setup";
import { applyToolbarMode, ATTACH_COMMAND_ID, isPlacedAfterAttach, restoreAttach, toolbarMode, UPLOAD_COMMAND_ID, type ToolbarMode } from "./toolbar";
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
import { bindingId, checkBinding, E2E_KEY_ID, hostOf, HTTP_SECRET_ID, originOf, S3_SECRET_ID } from "./secrets";
import { exportVaultKey, importVaultKey, keyFingerprint } from "./e2e/format";

const MB = 1024 * 1024;
const LINK_RE = /keyhole:\/\/[a-z0-9-]+\/[^\s)\]"'<>]+/gi;

/** Device-local: the set-up guide was shown on this device. */
const SETUP_SEEN_KEY = "keyhole-setup-seen";

export default class KeyholePlugin extends Plugin {
	settings: KeyholeSettings = { ...DEFAULT_SETTINGS };
	private backend: StorageBackend | null = null;
	private cache!: FileCache;
	private resolver!: Resolver;
	private renderer!: Renderer;
	private lastErrorNotice = 0;
	files!: FileActions;
	/** Opens the overview of local and uploaded files. */
	openOverview: () => void = () => undefined;
	/** Opens the set-up guide. */
	openSetup: (mode: SetupMode) => void = () => undefined;
	private hint: LocalAttachmentHint | null = null;

	async onload(): Promise<void> {
		initLanguage();
		await this.loadSettings();
		this.adoptSecretBindings();
		await this.refreshKeyState();

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
			() => this.keyForReading(),
		);
		this.renderer = new Renderer(this.resolver, (message) => this.reportError(message));
		this.renderer.setAlias(this.settings.alias);

		const uploader = new Uploader({
			app: this.app,
			settings: () => this.settings,
			backend: () => this.getBackend(),
			resolver: this.resolver,
			encryptionKey: () => this.keyForUploads(),
		});

		const migrator = new Migrator({ app: this.app, settings: () => this.settings, uploader });

		this.files = new FileActions({
			app: this.app,
			settings: () => this.settings,
			backend: () => this.getBackend(),
			resolver: this.resolver,
			renderer: this.renderer,
			uploader,
			canEncrypt: () => this.settings.e2eEnabled && this.keyMatches,
		});
		this.openOverview = () =>
			new OverviewModal({
				app: this.app,
				settings: () => this.settings,
				backend: () => this.getBackend(),
				migrator,
				files: this.files,
			}).open();
		this.addCommand({ id: "overview", name: t("command.overview"), icon: "list", callback: () => this.openOverview() });
		this.openSetup = (mode) => new SetupModal(this.app, this, migrator, mode).open();
		this.addCommand({ id: "setup", name: t("command.setup"), icon: "wand", callback: () => this.openSetup("full") });
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
			id: "encrypt-existing",
			name: t("command.encryptExisting"),
			icon: "lock",
			callback: () => void this.files.encryptExisting(),
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
			this.reapplyToolbar();
			if (!this.offerSetup() && Platform.isMobile) this.offerMobileToolbar();
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
		this.restoreToolbar();
		this.hint?.clear();
		this.app.workspace.iterateAllLeaves((leaf) => leaf.view.containerEl.doc.body.removeClass("keyhole-limit-edit-height"));
		this.renderer?.disconnect();
		this.resolver?.reset();
		this.cache?.close();
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<KeyholeSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
		// Before the metadata choice existed, pictures kept their metadata exactly when shrinking was off.
		if (data.imageMetadata === undefined && data.optimizeImages === false) this.settings.imageMetadata = "keep";
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

	/** The encryption key in this device's keychain, or null if there is none. */
	vaultKey(): Uint8Array<ArrayBuffer> | null {
		const text = this.app.secretStorage.getSecret(E2E_KEY_ID);
		return text ? importVaultKey(text) : null;
	}

	/**
	 * Is the key on this device the one this vault was set up with? Settings sync and
	 * keychains do not, so the two can disagree; the settings tab reads this.
	 */
	keyMatches = false;

	async refreshKeyState(): Promise<void> {
		const key = this.vaultKey();
		this.keyMatches = key !== null && this.settings.e2eFingerprint !== "" && (await keyFingerprint(key)) === this.settings.e2eFingerprint;
	}

	/** For reading, any key on the device is tried: a file tells by itself whether the key fits. */
	private keyForReading(): Promise<Uint8Array<ArrayBuffer>> {
		const key = this.vaultKey();
		return key ? Promise.resolve(key) : Promise.reject(new StorageError(t("e2e.noKey")));
	}

	/**
	 * For writing, only the vault's own key will do. Encrypting with any other key would
	 * produce files the other devices cannot read.
	 */
	private async keyForUploads(): Promise<Uint8Array<ArrayBuffer> | null> {
		if (!this.settings.e2eEnabled) return null;
		const key = this.vaultKey();
		if (!key) throw new StorageError(t("e2e.noKey"));
		if ((await keyFingerprint(key)) !== this.settings.e2eFingerprint) throw new StorageError(t("e2e.keyMismatch"));
		return key;
	}

	/** The key as text, to show it again. Null if this device does not have it. */
	vaultKeyText(): string | null {
		const key = this.vaultKey();
		return key ? exportVaultKey(key) : null;
	}

	/**
	 * Makes `key` the key of this vault: keeps it on this device and remembers its
	 * fingerprint in the settings. Used for a new key and for a key brought from
	 * another device before the settings arrived here.
	 */
	async setUpEncryption(key: Uint8Array<ArrayBuffer>): Promise<void> {
		this.app.secretStorage.setSecret(E2E_KEY_ID, exportVaultKey(key));
		this.settings.e2eFingerprint = await keyFingerprint(key);
		this.settings.e2eEnabled = true;
		await this.saveData(this.settings);
		await this.refreshKeyState();
		this.onSettingsChanged();
	}

	/**
	 * A key pasted on this device. If the vault has a key already, only that one is
	 * accepted; if the vault has none yet (as far as this device knows), the pasted
	 * key becomes the vault's key.
	 */
	async addVaultKey(text: string): Promise<"ok" | "invalid" | "other-key"> {
		const key = importVaultKey(text);
		if (!key) return "invalid";
		if (!this.settings.e2eFingerprint) {
			await this.setUpEncryption(key);
			return "ok";
		}
		if ((await keyFingerprint(key)) !== this.settings.e2eFingerprint) return "other-key";
		this.app.secretStorage.setSecret(E2E_KEY_ID, exportVaultKey(key));
		await this.refreshKeyState();
		this.onSettingsChanged();
		return "ok";
	}

	/** Settings changed on disk, e.g. another device's settings arrived through sync. */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		await this.refreshKeyState();
		this.onSettingsChanged();
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

	/** Where the upload button is in the mobile toolbar. Null if this Obsidian version does not let plugins look. */
	mobileToolbarMode(): ToolbarMode | null {
		const config = this.coreConfig();
		return config ? toolbarMode(this.toolbarCommands(config), this.settings.toolbarReplacesAttach) : null;
	}

	/** Takes the upload button out of the mobile toolbar, puts it after the paper clip, or puts it in the paper clip's place. */
	async setMobileToolbar(mode: ToolbarMode): Promise<void> {
		const config = this.coreConfig();
		if (!config) {
			new Notice(t("notice.toolbarUnavailable"));
			return;
		}
		const next = applyToolbarMode(this.toolbarCommands(config), mode, this.settings.toolbarReplacesAttach);
		config.set("mobileToolbarCommands", next.commands);
		this.settings.toolbarReplacesAttach = next.removedAttach;
		await this.saveData(this.settings);
		new Notice(t(mode === "off" ? "notice.toolbarRemoved" : mode === "replace" ? "notice.toolbarReplaced" : "notice.toolbarAdded"));
	}

	/**
	 * "Instead of the paper clip" survives a reload or an update of the plugin: unloading
	 * puts the paper clip back (so it is there if the plugin never returns), loading takes
	 * it out again. If the user removed the upload button in the meantime, the paper clip stays.
	 */
	private reapplyToolbar(): void {
		const config = this.coreConfig();
		if (!config || !this.settings.toolbarReplacesAttach) return;
		const commands = this.toolbarCommands(config);
		if (!commands.includes(UPLOAD_COMMAND_ID)) {
			config.set("mobileToolbarCommands", restoreAttach(commands));
			this.settings.toolbarReplacesAttach = false;
			void this.saveData(this.settings);
		} else if (commands.includes(ATTACH_COMMAND_ID)) {
			config.set("mobileToolbarCommands", commands.filter((c) => c !== ATTACH_COMMAND_ID));
		}
	}

	private restoreToolbar(): void {
		const config = this.coreConfig();
		if (!config || !this.settings?.toolbarReplacesAttach) return;
		config.set("mobileToolbarCommands", restoreAttach(this.toolbarCommands(config)));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.onSettingsChanged();
	}

	/** The storage address and account are filled in (they sync with the vault). */
	storageConfigured(): boolean {
		const s = this.settings;
		return s.storageType === "s3" ? Boolean(s.s3Endpoint && s.s3Bucket && s.s3AccessKeyId) : Boolean(s.httpUrl);
	}

	/** This device has the secret for the configured storage. */
	secretUsable(): boolean {
		if (!this.storageConfigured()) return false;
		try {
			this.createBackend();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Offers the set-up guide once: the full one for a vault that has no storage yet,
	 * the short one on a device that lacks the secret or the encryption key of a vault
	 * set up elsewhere. "Once" is per vault for the full guide (a synced setting) and
	 * per device for the short one. Returns true if a guide opened.
	 */
	private offerSetup(): boolean {
		const seenHere = this.app.loadLocalStorage(SETUP_SEEN_KEY) === "1";
		let mode: SetupMode;
		if (!this.storageConfigured()) {
			if (this.settings.setupDone || seenHere) return false;
			mode = "full";
		} else {
			const incomplete = !this.secretUsable() || (this.settings.e2eFingerprint !== "" && !this.keyMatches);
			if (!incomplete || seenHere) {
				if (!this.settings.setupDone) {
					this.settings.setupDone = true;
					void this.saveData(this.settings);
				}
				return false;
			}
			mode = "device";
		}
		this.app.saveLocalStorage(SETUP_SEEN_KEY, "1");
		this.settings.setupDone = true;
		// The guide asks about the toolbar itself.
		if (Platform.isMobile) this.settings.toolbarPrompted = true;
		void this.saveData(this.settings);
		this.openSetup(mode);
		return true;
	}

	/** Asks once (per vault, synced) whether to place the upload button in the mobile toolbar. */
	private offerMobileToolbar(): void {
		const config = this.coreConfig();
		if (!config || this.settings.toolbarPrompted || isPlacedAfterAttach(this.toolbarCommands(config))) return;
		new ToolbarPromptModal(this.app, (mode) => void this.setMobileToolbar(mode)).open();
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

/** Asked once on a phone or tablet: where the upload button goes. Nothing changes without a choice. */
class ToolbarPromptModal extends Modal {
	constructor(
		app: App,
		private readonly onChoose: (mode: ToolbarMode) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("toolbar.title"));
		this.contentEl.createEl("p", { text: t("toolbar.text") });
		const choose = (mode: ToolbarMode) => () => {
			this.onChoose(mode);
			this.close();
		};
		new Setting(this.contentEl)
			.setName(t("settings.toolbar.beside"))
			.setDesc(t("toolbar.beside.desc"))
			.addButton((b) => b.setButtonText(t("toolbar.choose")).setCta().onClick(choose("beside")));
		new Setting(this.contentEl)
			.setName(t("settings.toolbar.replace"))
			.setDesc(t("toolbar.replace.desc"))
			.addButton((b) => b.setButtonText(t("toolbar.choose")).onClick(choose("replace")));
		new Setting(this.contentEl).addButton((b) => b.setButtonText(t("toolbar.notNow")).onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
