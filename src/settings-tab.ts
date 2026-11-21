import { Modal, Notice, PluginSettingTab, Setting, type App, type SettingDefinitionItem } from "obsidian";
import { exportVaultKey, generateVaultKey, importVaultKey } from "./e2e/format";
import { t } from "./i18n";
import type KeyholePlugin from "./main";
import { bindingId, checkBinding, HTTP_SECRET_ID, S3_SECRET_ID } from "./secrets";

export class KeyholeSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: KeyholePlugin,
	) {
		super(app, plugin);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.plugin.onSettingsChanged();
		this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const isS3 = () => s.storageType === "s3";
		const isHttp = () => s.storageType !== "s3";

		return [
			{
				type: "group",
				heading: t("settings.storage"),
				items: [
					{
						name: t("settings.storageType"),
						desc: t("settings.storageType.desc"),
						control: {
							type: "dropdown",
							key: "storageType",
							options: {
								s3: t("settings.storageType.s3"),
								keyhole: t("settings.storageType.keyhole"),
								webdav: t("settings.storageType.webdav"),
							},
						},
					},
					{
						name: t("settings.endpoint"),
						desc: t("settings.endpoint.desc"),
						visible: isS3,
						control: { type: "text", key: "s3Endpoint", placeholder: "https://" },
					},
					{
						name: t("settings.region"),
						desc: t("settings.region.desc"),
						visible: isS3,
						control: { type: "text", key: "s3Region", placeholder: "auto" },
					},
					{
						name: t("settings.bucket"),
						desc: t("settings.bucket.desc"),
						visible: isS3,
						control: { type: "text", key: "s3Bucket" },
					},
					{
						name: t("settings.pathStyle"),
						desc: t("settings.pathStyle.desc"),
						visible: isS3,
						control: { type: "toggle", key: "s3PathStyle" },
					},
					{
						name: t("settings.accessKeyId"),
						visible: isS3,
						control: { type: "text", key: "s3AccessKeyId" },
					},
					{
						name: t("settings.secretAccessKey"),
						visible: isS3,
						render: (setting) => this.renderSecret(setting, "s3SecretKeyRef", S3_SECRET_ID),
					},
					{
						name: t("settings.serverUrl"),
						desc: t("settings.serverUrl.desc"),
						visible: isHttp,
						control: { type: "text", key: "httpUrl", placeholder: "https://" },
					},
					{
						name: t("settings.auth"),
						visible: () => s.storageType === "webdav",
						control: {
							type: "dropdown",
							key: "httpAuth",
							options: { bearer: t("settings.auth.bearer"), basic: t("settings.auth.basic") },
						},
					},
					{
						name: t("settings.username"),
						visible: () => s.storageType === "webdav" && s.httpAuth === "basic",
						control: { type: "text", key: "httpUsername" },
					},
					{
						name: t("settings.tokenOrPassword"),
						visible: isHttp,
						render: (setting) => this.renderSecret(setting, "httpSecretRef", HTTP_SECRET_ID),
					},
					{
						name: t("settings.test"),
						desc: t("settings.test.desc"),
						action: () => void this.testConnection(),
					},
				],
			},
			{
				type: "group",
				heading: t("settings.uploads"),
				items: [
					{
						name: t("settings.scope"),
						desc: t("settings.scope.desc"),
						control: {
							type: "dropdown",
							key: "uploadScope",
							options: {
								all: t("settings.scope.all"),
								media: t("settings.scope.media"),
								images: t("settings.scope.images"),
							},
						},
					},
					{
						name: t("settings.optimize"),
						desc: t("settings.optimize.desc"),
						control: { type: "toggle", key: "optimizeImages" },
					},
					{
						name: t("settings.maxEdge"),
						visible: () => s.optimizeImages,
						control: { type: "number", key: "imageMaxEdge", min: 640, max: 8192 },
					},
					{
						name: t("settings.quality"),
						visible: () => s.optimizeImages,
						control: { type: "number", key: "imageQuality", min: 50, max: 100 },
					},
					{
						name: t("settings.toolbar"),
						desc: t("settings.toolbar.desc"),
						action: () => {
							this.plugin.addToMobileToolbar();
						},
					},
					{
						name: t("settings.maxUpload"),
						desc: t("settings.maxUpload.desc"),
						control: { type: "number", key: "maxUploadMB", min: 1, max: 2048 },
					},
					{
						name: t("settings.fallback"),
						desc: t("settings.fallback.desc"),
						control: { type: "toggle", key: "fallbackToLocal" },
					},
					{
						name: t("settings.trashMoved"),
						desc: t("settings.trashMoved.desc"),
						control: { type: "toggle", key: "trashMovedAttachments" },
					},
					{
						name: t("settings.suggestMove"),
						desc: t("settings.suggestMove.desc"),
						control: { type: "toggle", key: "suggestMove" },
					},
					{
						name: t("settings.prefix"),
						desc: t("settings.prefix.desc"),
						control: { type: "text", key: "keyPrefix", placeholder: "my-vault/" },
					},
					{
						name: t("settings.alias"),
						desc: t("settings.alias.desc"),
						control: {
							type: "text",
							key: "alias",
							validate: (v) =>
								/^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? undefined : t("settings.alias.invalid"),
						},
					},
				],
			},
			{
				type: "group",
				heading: t("settings.e2e"),
				items: [
					{
						name: t("settings.e2e.setup"),
						desc: t("settings.e2e.setup.desc"),
						visible: () => !s.e2eFingerprint,
						action: () => {
							// Never replace a key that is already on this device: files may depend on it.
							const existing = this.plugin.vaultKey();
							if (existing) {
								void this.plugin.setUpEncryption(existing).then(() => {
									this.refreshDomState();
									new Notice(t("notice.e2eAdopted"), 10000);
								});
								return;
							}
							new EncryptionSetupModal(this.app, async (key) => {
								await this.plugin.setUpEncryption(key);
								this.refreshDomState();
								new Notice(t("notice.e2eOn"));
							}).open();
						},
					},
					{
						// Encryption may be set up on another device whose settings have not arrived here yet.
						name: t("settings.e2e.existing"),
						visible: () => !s.e2eFingerprint,
						render: (setting) => this.renderKeyEntry(setting, t("settings.e2e.existing.desc")),
					},
					{
						name: t("settings.e2e.enabled"),
						desc: t("settings.e2e.enabled.desc"),
						visible: () => Boolean(s.e2eFingerprint) && this.plugin.keyMatches,
						control: { type: "toggle", key: "e2eEnabled" },
					},
					{
						name: t("settings.e2e.show"),
						desc: t("settings.e2e.show.desc"),
						visible: () => Boolean(s.e2eFingerprint) && this.plugin.keyMatches,
						action: () => {
							const text = this.plugin.vaultKeyText();
							if (text) new EncryptionKeyModal(this.app, text).open();
						},
					},
					{
						name: t("settings.e2e.enter"),
						visible: () => Boolean(s.e2eFingerprint) && !this.plugin.keyMatches,
						render: (setting) => this.renderKeyEntry(setting, t("settings.e2e.enter.desc")),
					},
				],
			},
			{
				type: "group",
				heading: t("settings.display"),
				items: [
					{
						name: t("settings.limitHeight"),
						desc: t("settings.limitHeight.desc"),
						control: { type: "toggle", key: "limitEditHeight" },
					},
					{
						name: t("settings.maxHeight"),
						visible: () => s.limitEditHeight,
						control: { type: "number", key: "editMaxHeightPercent", min: 10, max: 100 },
					},
				],
			},
			{
				type: "group",
				heading: t("settings.cache"),
				items: [
					{
						name: t("settings.cacheEnabled"),
						desc: t("settings.cacheEnabled.desc"),
						control: { type: "toggle", key: "cacheEnabled" },
					},
					{
						name: t("settings.cacheSize"),
						desc: t("settings.cacheSize.desc"),
						visible: () => s.cacheEnabled,
						control: { type: "number", key: "cacheMaxMB", min: 10, max: 20000 },
					},
					{
						name: t("settings.cacheMaxFile"),
						visible: () => s.cacheEnabled,
						control: { type: "number", key: "cacheMaxFileMB", min: 1, max: 2048 },
					},
					{
						name: t("settings.stream"),
						desc: t("settings.stream.desc"),
						control: { type: "toggle", key: "streamLargeMedia" },
					},
					{
						name: t("settings.cleanup"),
						desc: t("settings.cleanup.desc"),
						action: () => this.plugin.files.cleanup(),
					},
					{
						name: t("settings.restoreVault"),
						desc: t("settings.restoreVault.desc"),
						action: () => void this.plugin.files.restoreVault(),
					},
					{
						name: t("settings.clearCache"),
						desc: t("settings.clearCache.desc"),
						action: () => void this.plugin.clearCache(),
					},
				],
			},
		];
	}

	/**
	 * A plain "paste and save" field. The value goes straight into this device's
	 * keychain (app.secretStorage) under an id Keyhole picks itself, so people never
	 * have to invent a keychain id or go through the generic keychain dialog.
	 * Only the id is stored in data.json.
	 */
	private renderSecret(setting: Setting, refKey: "s3SecretKeyRef" | "httpSecretRef", id: string): void {
		const settings = this.plugin.settings;
		const address = () => (refKey === "s3SecretKeyRef" ? settings.s3Endpoint : settings.httpUrl);
		const stored = () => Boolean(this.app.secretStorage.getSecret(id));
		// A secret saved for another host is not used: say so, instead of "saved".
		const usable = () => stored() && checkBinding(this.app.secretStorage.getSecret(bindingId(id)), address()) === "ok";
		const describe = () =>
			setting.setDesc(
				usable() ? t("settings.secret.saved") : stored() ? t("settings.secret.otherHost") : t("settings.secret.missing"),
			);
		describe();
		let value = "";
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.autocomplete = "off";
			text.setPlaceholder(stored() ? "••••••••" : t("settings.secret.placeholder")).onChange((v) => (value = v.trim()));
		});
		setting.addButton((button) =>
			button
				.setButtonText(t("settings.secret.save"))
				.setCta()
				.onClick(async () => {
					if (!value) {
						new Notice(t("notice.pasteFirst"));
						return;
					}
					this.app.secretStorage.setSecret(id, value);
					this.plugin.bindSecret(id, address());
					await this.setControlValue(refKey, id);
					value = "";
					const input = setting.controlEl.querySelector("input");
					if (input) {
						input.value = "";
						input.placeholder = "••••••••";
					}
					describe();
					new Notice(t("notice.secretSaved"));
				}),
		);
	}

	/** On a device that does not have the vault's encryption key yet: paste it once. */
	private renderKeyEntry(setting: Setting, description: string): void {
		setting.setDesc(description);
		let value = "";
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.autocomplete = "off";
			text.setPlaceholder("keyhole-key-v1:…").onChange((v) => (value = v.trim()));
		});
		setting.addButton((button) =>
			button
				.setButtonText(t("settings.secret.save"))
				.setCta()
				.onClick(async () => {
					const result = await this.plugin.addVaultKey(value);
					if (result === "ok") {
						new Notice(t("notice.e2eKeyAdded"));
						this.refreshDomState();
					} else {
						new Notice(t(result === "invalid" ? "notice.e2eKeyInvalid" : "notice.e2eKeyOther"), 8000);
					}
				}),
		);
	}

	private async testConnection(): Promise<void> {
		const notice = new Notice(t("notice.testing"), 0);
		try {
			const backend = this.plugin.createBackend();
			await backend.test();
			notice.setMessage(t("notice.testOk"));
		} catch (err) {
			notice.setMessage(t("notice.testFailed", { message: err instanceof Error ? err.message : t("error.unknown") }));
		} finally {
			window.setTimeout(() => notice.hide(), 6000);
		}
	}
}

/**
 * First set-up of encryption. A lost key means lost files, so the key must be
 * saved before anything is encrypted with it: the button stays off until the key
 * was pasted back (from wherever it was saved) and the consequence was acknowledged.
 */
class EncryptionSetupModal extends Modal {
	private readonly key = generateVaultKey();

	constructor(
		app: App,
		private readonly onConfirm: (key: Uint8Array<ArrayBuffer>) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const text = exportVaultKey(this.key);
		this.setTitle(t("e2e.setup.title"));
		contentEl.createEl("p", { text: t("e2e.setup.intro") });
		const list = contentEl.createEl("ul");
		for (const key of ["e2e.setup.point.lost", "e2e.setup.point.devices", "e2e.setup.point.stream", "e2e.setup.point.existing"] as const) {
			list.createEl("li", { text: t(key) });
		}

		contentEl.createEl("p", { cls: "keyhole-key-step", text: t("e2e.setup.step1") });
		renderKey(contentEl, text);

		contentEl.createEl("p", { cls: "keyhole-key-step", text: t("e2e.setup.step2") });
		let pasted = "";
		let acknowledged = false;
		let confirm: HTMLButtonElement | null = null;
		const update = () => {
			const key = importVaultKey(pasted);
			const matches = key !== null && exportVaultKey(key) === text;
			if (confirm) confirm.disabled = !(matches && acknowledged);
			status.setText(pasted && !matches ? t("e2e.setup.mismatch") : "");
		};
		new Setting(contentEl).setName(t("e2e.setup.paste")).addText((input) => {
			input.inputEl.autocomplete = "off";
			input.inputEl.addClass("keyhole-key-input");
			input.setPlaceholder("keyhole-key-v1:…").onChange((v) => {
				pasted = v;
				update();
			});
		});
		const status = contentEl.createEl("p", { cls: "keyhole-status-error" });
		new Setting(contentEl).setName(t("e2e.setup.ack")).addToggle((toggle) =>
			toggle.onChange((v) => {
				acknowledged = v;
				update();
			}),
		);
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) => {
				confirm = b.buttonEl;
				b.setButtonText(t("e2e.setup.confirm"))
					.setCta()
					.onClick(async () => {
						await this.onConfirm(this.key);
						this.close();
					});
			});
		update();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Shows the key again, e.g. to copy it to another device. */
class EncryptionKeyModal extends Modal {
	constructor(
		app: App,
		private readonly text: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("settings.e2e.show"));
		this.contentEl.createEl("p", { text: t("e2e.show.text") });
		renderKey(this.contentEl, this.text);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function renderKey(parent: HTMLElement, text: string): void {
	const box = parent.createDiv({ cls: "keyhole-key-box" });
	box.createEl("code", { cls: "keyhole-key-text", text });
	const copy = box.createEl("button", { text: t("e2e.copy") });
	copy.addEventListener("click", () => {
		void navigator.clipboard.writeText(text).then(() => new Notice(t("e2e.copied")));
	});
}
