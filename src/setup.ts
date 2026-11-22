import { Modal, Notice, Platform, Setting, type App } from "obsidian";
import { t } from "./i18n";
import type KeyholePlugin from "./main";
import type { MetadataMode } from "./metadata";
import type { Migrator } from "./migrate";
import { formatBytes } from "./migrate-rules";
import { movableSummary, runMoveAll } from "./move-all";
import { messageOf } from "./render";
import { HTTP_SECRET_ID, S3_SECRET_ID } from "./secrets";
import { EncryptionSetupModal } from "./settings-tab";
import type { StorageType, UploadScope } from "./settings";
import type { ToolbarMode } from "./toolbar";

/** "full": nothing is set up yet. "device": the vault is set up, this device lacks its secret or key. */
export type SetupMode = "full" | "device";

type Step = "storage" | "device" | "uploads" | "encryption" | "toolbar" | "existing" | "done";

/**
 * Walks through everything Keyhole needs, one question per page. Every page writes
 * the same settings as the settings tab, so leaving at any point loses nothing and
 * the guide can be run again.
 */
export class SetupModal extends Modal {
	private readonly steps: Step[];
	private index = 0;
	/** The secret typed on the storage or device page; saved to the keychain when the connection is tested. */
	private secret = "";
	private tested = false;
	private status: { ok: boolean; text: string } | null = null;

	constructor(
		app: App,
		private readonly plugin: KeyholePlugin,
		private readonly migrator: Migrator,
		mode: SetupMode,
	) {
		super(app);
		const toolbar = Platform.isMobile && plugin.mobileToolbarMode() !== null;
		this.steps =
			mode === "device"
				? ["device", ...(toolbar && plugin.mobileToolbarMode() === "off" ? (["toolbar"] as const) : []), "done"]
				: ["storage", "uploads", "encryption", ...(toolbar ? (["toolbar"] as const) : []), "existing", "done"];
		this.tested = plugin.secretUsable();
	}

	onOpen(): void {
		this.modalEl.addClass("keyhole-setup-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private get step(): Step {
		return this.steps[this.index] ?? "done";
	}

	private go(delta: number): void {
		let next = this.index + delta;
		// Nothing to move: that page has nothing to ask.
		if (this.steps[next] === "existing" && !movableSummary(this.migrator).count) next += delta;
		this.index = Math.max(0, Math.min(this.steps.length - 1, next));
		this.status = null;
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const s = this.step;
		this.setTitle(t(`setup.${s}.title`));
		if (s !== "done") {
			contentEl.createEl("p", {
				cls: "keyhole-setup-progress",
				text: t("setup.progress", { step: this.index + 1, count: this.steps.length - 1 }),
			});
		}
		contentEl.createEl("p", { text: t(`setup.${s}.text`) });
		const next = { label: t("setup.next"), enabled: true };
		if (s === "storage") this.renderStorage(next);
		else if (s === "device") this.renderDevice(next);
		else if (s === "uploads") this.renderUploads();
		else if (s === "encryption") this.renderEncryption(next);
		else if (s === "toolbar") this.renderToolbar(next);
		else if (s === "existing") this.renderExisting(next);

		if (this.status) contentEl.createEl("p", { cls: this.status.ok ? "keyhole-setup-ok" : "keyhole-status-error", text: this.status.text });

		const nav = new Setting(contentEl);
		if (s === "done") {
			nav.addButton((b) => b.setButtonText(t("setup.finish")).setCta().onClick(() => this.close()));
			return;
		}
		if (this.index > 0) nav.addButton((b) => b.setButtonText(t("setup.back")).onClick(() => this.go(-1)));
		nav.addButton((b) => b.setButtonText(t("setup.later")).onClick(() => this.close()));
		nav.addButton((b) =>
			b
				.setButtonText(next.label)
				.setCta()
				.setDisabled(!next.enabled)
				.onClick(() => this.go(1)),
		);
	}

	private text(name: string, value: string, placeholder: string, onChange: (v: string) => void, desc?: string): void {
		const setting = new Setting(this.contentEl).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addText((input) =>
			input
				.setPlaceholder(placeholder)
				.setValue(value)
				.onChange((v) => {
					onChange(v.trim());
					this.tested = false;
				}),
		);
	}

	private secretField(name: string, stored: boolean): void {
		new Setting(this.contentEl)
			.setName(name)
			.setDesc(t(stored ? "settings.secret.saved" : "setup.secret.desc"))
			.addText((input) => {
				input.inputEl.type = "password";
				input.inputEl.autocomplete = "off";
				input.setPlaceholder(stored ? "••••••••" : t("settings.secret.placeholder")).onChange((v) => {
					this.secret = v.trim();
					this.tested = false;
				});
			});
	}

	private testButton(): void {
		new Setting(this.contentEl)
			.setName(t("settings.test"))
			.setDesc(t("settings.test.desc"))
			.addButton((b) =>
				b
					.setButtonText(t("setup.test"))
					.setCta()
					.onClick(() => void this.test()),
			);
	}

	/** Saves what was typed, including the secret, and tries the storage. */
	private async test(): Promise<void> {
		const { settings } = this.plugin;
		const s3 = settings.storageType === "s3";
		if (this.secret) {
			const id = s3 ? S3_SECRET_ID : HTTP_SECRET_ID;
			this.app.secretStorage.setSecret(id, this.secret);
			this.plugin.bindSecret(id, s3 ? settings.s3Endpoint : settings.httpUrl);
			if (s3) settings.s3SecretKeyRef = id;
			else settings.httpSecretRef = id;
			this.secret = "";
		}
		await this.plugin.saveSettings();
		this.status = { ok: true, text: t("notice.testing") };
		this.render();
		try {
			await this.plugin.createBackend().test();
			this.tested = true;
			this.status = { ok: true, text: t("setup.test.ok") };
		} catch (err) {
			this.tested = false;
			this.status = { ok: false, text: messageOf(err) };
		}
		this.render();
	}

	private renderStorage(next: { label: string; enabled: boolean }): void {
		const { settings } = this.plugin;
		new Setting(this.contentEl)
			.setName(t("settings.storageType"))
			.setDesc(t("settings.storageType.desc"))
			.addDropdown((d) =>
				d
					.addOptions({ s3: t("settings.storageType.s3"), keyhole: t("settings.storageType.keyhole"), webdav: t("settings.storageType.webdav") })
					.setValue(settings.storageType)
					.onChange((v) => {
						settings.storageType = v as StorageType;
						this.tested = false;
						this.status = null;
						this.render();
					}),
			);
		if (settings.storageType === "s3") {
			this.text(t("settings.endpoint"), settings.s3Endpoint, "https://", (v) => (settings.s3Endpoint = v), t("settings.endpoint.desc"));
			this.text(t("settings.region"), settings.s3Region, "auto", (v) => (settings.s3Region = v), t("settings.region.desc"));
			this.text(t("settings.bucket"), settings.s3Bucket, "", (v) => (settings.s3Bucket = v), t("settings.bucket.desc"));
			this.text(t("settings.accessKeyId"), settings.s3AccessKeyId, "", (v) => (settings.s3AccessKeyId = v));
			this.secretField(t("settings.secretAccessKey"), Boolean(this.app.secretStorage.getSecret(S3_SECRET_ID)));
		} else {
			this.text(t("settings.serverUrl"), settings.httpUrl, "https://", (v) => (settings.httpUrl = v), t("settings.serverUrl.desc"));
			if (settings.storageType === "webdav") {
				new Setting(this.contentEl).setName(t("settings.auth")).addDropdown((d) =>
					d
						.addOptions({ bearer: t("settings.auth.bearer"), basic: t("settings.auth.basic") })
						.setValue(settings.httpAuth)
						.onChange((v) => {
							settings.httpAuth = v as "bearer" | "basic";
							this.tested = false;
							this.render();
						}),
				);
				if (settings.httpAuth === "basic") this.text(t("settings.username"), settings.httpUsername, "", (v) => (settings.httpUsername = v));
			}
			this.secretField(t("settings.tokenOrPassword"), Boolean(this.app.secretStorage.getSecret(HTTP_SECRET_ID)));
		}
		this.testButton();
		next.enabled = this.tested;
	}

	/** The vault is set up elsewhere: this device only needs what never syncs. */
	private renderDevice(next: { label: string; enabled: boolean }): void {
		const { settings } = this.plugin;
		const s3 = settings.storageType === "s3";
		if (!this.plugin.secretUsable()) {
			this.secretField(t(s3 ? "settings.secretAccessKey" : "settings.tokenOrPassword"), false);
			this.testButton();
		}
		if (settings.e2eFingerprint && !this.plugin.keyMatches) this.keyField(t("settings.e2e.enter.desc"));
		next.enabled = this.tested && (!settings.e2eFingerprint || this.plugin.keyMatches);
	}

	private keyField(desc: string): void {
		let value = "";
		new Setting(this.contentEl)
			.setName(t("settings.e2e.enter"))
			.setDesc(desc)
			.addText((input) => {
				input.inputEl.type = "password";
				input.inputEl.autocomplete = "off";
				input.setPlaceholder("keyhole-key-v1:…").onChange((v) => (value = v.trim()));
			})
			.addButton((b) =>
				b.setButtonText(t("settings.secret.save")).onClick(async () => {
					const result = await this.plugin.addVaultKey(value);
					if (result === "ok") this.status = { ok: true, text: t("notice.e2eKeyAdded") };
					else this.status = { ok: false, text: t(result === "invalid" ? "notice.e2eKeyInvalid" : "notice.e2eKeyOther") };
					this.render();
				}),
			);
	}

	private renderUploads(): void {
		const { settings } = this.plugin;
		const save = () => void this.plugin.saveSettings();
		new Setting(this.contentEl)
			.setName(t("settings.scope"))
			.setDesc(t("settings.scope.desc"))
			.addDropdown((d) =>
				d
					.addOptions({ all: t("settings.scope.all"), media: t("settings.scope.media"), images: t("settings.scope.images") })
					.setValue(settings.uploadScope)
					.onChange((v) => {
						settings.uploadScope = v as UploadScope;
						save();
					}),
			);
		new Setting(this.contentEl)
			.setName(t("settings.optimize"))
			.setDesc(t("setup.uploads.shrink"))
			.addToggle((toggle) =>
				toggle.setValue(settings.optimizeImages).onChange((v) => {
					settings.optimizeImages = v;
					save();
				}),
			);
		new Setting(this.contentEl)
			.setName(t("settings.metadata"))
			.setDesc(t("setup.uploads.metadata"))
			.addDropdown((d) =>
				d
					.addOptions({ keep: t("settings.metadata.keep"), "no-location": t("settings.metadata.noLocation"), strip: t("settings.metadata.strip") })
					.setValue(settings.imageMetadata)
					.onChange((v) => {
						settings.imageMetadata = v as MetadataMode;
						save();
					}),
			);
	}

	private renderEncryption(next: { label: string; enabled: boolean }): void {
		const { settings } = this.plugin;
		if (settings.e2eFingerprint && this.plugin.keyMatches) {
			this.contentEl.createEl("p", { cls: "keyhole-setup-ok", text: t("setup.encryption.on") });
			return;
		}
		if (settings.e2eFingerprint) {
			// Set up on another device: only the key is missing here.
			this.keyField(t("settings.e2e.enter.desc"));
			next.label = t("setup.encryption.skip");
			return;
		}
		new Setting(this.contentEl)
			.setName(t("settings.e2e.setup"))
			.setDesc(t("setup.encryption.new"))
			.addButton((b) =>
				b.setButtonText(t("setup.encryption.start")).onClick(() => {
					// Never replace a key that is already on this device: files may depend on it.
					const existing = this.plugin.vaultKey();
					if (existing) {
						void this.plugin.setUpEncryption(existing).then(() => {
							new Notice(t("notice.e2eAdopted"), 10000);
							this.render();
						});
						return;
					}
					new EncryptionSetupModal(this.app, async (key) => {
						await this.plugin.setUpEncryption(key);
						this.render();
					}).open();
				}),
			);
		this.keyField(t("settings.e2e.existing.desc"));
		next.label = t("setup.encryption.skip");
	}

	private renderToolbar(next: { label: string; enabled: boolean }): void {
		const current = this.plugin.mobileToolbarMode();
		const choice = (mode: ToolbarMode, name: string, desc: string) =>
			new Setting(this.contentEl)
				.setName(name)
				.setDesc(desc)
				.addButton((b) => {
					b.setButtonText(t(current === mode ? "setup.toolbar.chosen" : "toolbar.choose")).onClick(async () => {
						await this.plugin.setMobileToolbar(mode);
						this.render();
					});
					if (current === mode) b.setCta();
				});
		choice("beside", t("settings.toolbar.beside"), t("toolbar.beside.desc"));
		choice("replace", t("settings.toolbar.replace"), t("toolbar.replace.desc"));
		if (current === "off") next.label = t("setup.toolbar.skip");
	}

	private renderExisting(next: { label: string; enabled: boolean }): void {
		const { count, bytes } = movableSummary(this.migrator);
		new Setting(this.contentEl)
			.setName(t("moveAll.name", { count, size: formatBytes(bytes) }))
			.setDesc(t("setup.existing.desc"))
			.addButton((b) =>
				b.setButtonText(t("moveAll.button")).onClick(() => {
					this.index = this.steps.length - 1;
					this.render();
					void runMoveAll(this.migrator);
				}),
			);
		next.label = t("setup.existing.skip");
	}
}
