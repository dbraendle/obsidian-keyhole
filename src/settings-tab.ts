import { Notice, PluginSettingTab, type App, type Setting, type SettingDefinitionItem } from "obsidian";
import type KeyholePlugin from "./main";

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
				heading: "Storage",
				items: [
					{
						name: "Storage type",
						desc: "S3-compatible: AWS S3, Cloudflare R2, Backblaze B2, MinIO, Garage. WebDAV: Nextcloud, Synology, rclone. All options keep files private.",
						control: {
							type: "dropdown",
							key: "storageType",
							options: {
								s3: "S3-compatible",
								keyhole: "Keyhole server",
								webdav: "WebDAV",
							},
						},
					},
					{
						name: "Endpoint",
						desc: "For example https://<account>.r2.cloudflarestorage.com or https://s3.eu-central-1.amazonaws.com",
						visible: isS3,
						control: { type: "text", key: "s3Endpoint", placeholder: "https://" },
					},
					{
						name: "Region",
						desc: "Use auto for Cloudflare R2.",
						visible: isS3,
						control: { type: "text", key: "s3Region", placeholder: "auto" },
					},
					{
						name: "Bucket",
						desc: "Keep the bucket private. Keyhole never needs public access.",
						visible: isS3,
						control: { type: "text", key: "s3Bucket" },
					},
					{
						name: "Path-style URLs",
						desc: "Needed for MinIO and most self-hosted servers. Turn off only if your provider requires virtual-hosted URLs.",
						visible: isS3,
						control: { type: "toggle", key: "s3PathStyle" },
					},
					{
						name: "Access key ID",
						visible: isS3,
						control: { type: "text", key: "s3AccessKeyId" },
					},
					{
						name: "Secret access key",
						visible: isS3,
						render: (setting) => this.renderSecret(setting, "s3SecretKeyRef", "keyhole-s3-secret"),
					},
					{
						name: "Server URL",
						desc: "Base URL that files are stored under, for example https://files.example.com/f/",
						visible: isHttp,
						control: { type: "text", key: "httpUrl", placeholder: "https://" },
					},
					{
						name: "Authentication",
						visible: () => s.storageType === "webdav",
						control: {
							type: "dropdown",
							key: "httpAuth",
							options: { bearer: "Token", basic: "Username + password" },
						},
					},
					{
						name: "Username",
						visible: () => s.storageType === "webdav" && s.httpAuth === "basic",
						control: { type: "text", key: "httpUsername" },
					},
					{
						name: "Token or password",
						visible: isHttp,
						render: (setting) => this.renderSecret(setting, "httpSecretRef", "keyhole-server-secret"),
					},
					{
						name: "Test connection",
						desc: "Uploads and reads back a small test file.",
						action: () => void this.testConnection(),
					},
				],
			},
			{
				type: "group",
				heading: "Uploads",
				items: [
					{
						name: "Upload these files",
						desc: "Matching files you drop, paste or pick go to your storage; everything else is handled by Obsidian as usual. Media means images, audio, video and PDF.",
						control: {
							type: "dropdown",
							key: "uploadScope",
							options: {
								all: "All files",
								media: "Media only",
								images: "Images only",
							},
						},
					},
					{
						name: "Shrink images before upload",
						desc: "Resizes and re-encodes photos and screenshots on this device (WebP or JPEG). A 9 MB phone screenshot becomes a few hundred KB. Also removes location data. GIF and SVG stay as they are.",
						control: { type: "toggle", key: "optimizeImages" },
					},
					{
						name: "Longest image edge (pixels)",
						visible: () => s.optimizeImages,
						control: { type: "number", key: "imageMaxEdge", min: 640, max: 8192 },
					},
					{
						name: "Image quality (%)",
						visible: () => s.optimizeImages,
						control: { type: "number", key: "imageQuality", min: 50, max: 100 },
					},
					{
						name: "Upload button in the mobile toolbar",
						desc: "Puts the upload button right after the attachment (paper clip) button in the toolbar above the keyboard on phones and tablets.",
						action: () => {
							this.plugin.addToMobileToolbar();
						},
					},
					{
						name: "Maximum upload size (MB)",
						desc: "Larger files are left to Obsidian.",
						control: { type: "number", key: "maxUploadMB", min: 1, max: 2048 },
					},
					{
						name: "Keep a local copy if the upload fails",
						desc: "When you are offline or the storage is unreachable, the file is saved as a normal attachment instead of being lost.",
						control: { type: "toggle", key: "fallbackToLocal" },
					},
					{
						name: "Key prefix",
						desc: "Optional folder in the storage, for example the vault name. Changing it only affects new uploads.",
						control: { type: "text", key: "keyPrefix", placeholder: "my-vault/" },
					},
					{
						name: "Storage name in links",
						desc: "Links look like keyhole://main/… Only change this before your first upload.",
						control: {
							type: "text",
							key: "alias",
							validate: (v) =>
								/^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? undefined : "Lowercase letters, digits and dashes only.",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Display",
				items: [
					{
						name: "Limit image height while editing",
						desc: "In Live Preview, tall images such as phone screenshots take at most part of the screen height, so writing around them stays easy. Wide images keep the full width. Reading view always shows images in full.",
						control: { type: "toggle", key: "limitEditHeight" },
					},
					{
						name: "Maximum height (% of the window)",
						visible: () => s.limitEditHeight,
						control: { type: "number", key: "editMaxHeightPercent", min: 10, max: 100 },
					},
				],
			},
			{
				type: "group",
				heading: "Offline cache",
				items: [
					{
						name: "Keep viewed files on this device",
						desc: "Files you have viewed stay available offline. The cache lives on this device only and is not synced.",
						control: { type: "toggle", key: "cacheEnabled" },
					},
					{
						name: "Cache size (MB)",
						desc: "Least recently viewed files are removed first.",
						visible: () => s.cacheEnabled,
						control: { type: "number", key: "cacheMaxMB", min: 10, max: 20000 },
					},
					{
						name: "Largest file to cache (MB)",
						visible: () => s.cacheEnabled,
						control: { type: "number", key: "cacheMaxFileMB", min: 1, max: 2048 },
					},
					{
						name: "Stream large audio and video",
						desc: "Play large media directly from the storage with a short-lived signed link instead of downloading it first. Works with S3 and the Keyhole server.",
						control: { type: "toggle", key: "streamLargeMedia" },
					},
					{
						name: "Clear cache",
						desc: "Removes all cached files from this device.",
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
	private renderSecret(setting: Setting, refKey: "s3SecretKeyRef" | "httpSecretRef", defaultId: string): void {
		const settings = this.plugin.settings;
		const stored = () => {
			const ref = settings[refKey];
			return Boolean(ref && this.app.secretStorage.getSecret(ref));
		};
		const describe = () =>
			setting.setDesc(
				stored()
					? "Saved on this device. Paste a new value to replace it."
					: "Paste it here and press Save. It is kept in this device's keychain only, never in your vault, so do this once on every device.",
			);
		describe();
		let value = "";
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.autocomplete = "off";
			text.setPlaceholder(stored() ? "••••••••" : "Paste here").onChange((v) => (value = v.trim()));
		});
		setting.addButton((button) =>
			button
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					if (!value) {
						new Notice("Keyhole: paste the value first.");
						return;
					}
					const id = settings[refKey] || defaultId;
					this.app.secretStorage.setSecret(id, value);
					await this.setControlValue(refKey, id);
					value = "";
					const input = setting.controlEl.querySelector("input");
					if (input) {
						input.value = "";
						input.placeholder = "••••••••";
					}
					describe();
					new Notice("Keyhole: saved on this device.");
				}),
		);
	}

	private async testConnection(): Promise<void> {
		const notice = new Notice("Keyhole: testing connection…", 0);
		try {
			const backend = this.plugin.createBackend();
			await backend.test();
			notice.setMessage("Keyhole: connection works.");
		} catch (err) {
			notice.setMessage(`Keyhole: ${err instanceof Error ? err.message : "connection failed"}`);
		} finally {
			window.setTimeout(() => notice.hide(), 6000);
		}
	}
}
