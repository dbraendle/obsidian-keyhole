import type { MetadataMode } from "./metadata";

export type StorageType = "s3" | "webdav" | "keyhole";

export type UploadScope = "all" | "media" | "images";

/**
 * Everything here is stored in the plugin's data.json, which may be synced or
 * committed to Git along with the vault. It therefore holds no secrets: secret
 * fields only hold the *name* of an entry in Obsidian's device-local keychain
 * (app.secretStorage).
 */
export interface KeyholeSettings {
	storageType: StorageType;
	alias: string;
	keyPrefix: string;

	s3Endpoint: string;
	s3Region: string;
	s3Bucket: string;
	s3PathStyle: boolean;
	s3AccessKeyId: string;
	s3SecretKeyRef: string;

	httpUrl: string;
	httpAuth: "bearer" | "basic";
	httpUsername: string;
	httpSecretRef: string;

	uploadScope: UploadScope;
	maxUploadMB: number;
	optimizeImages: boolean;
	imageMaxEdge: number;
	imageQuality: number;
	/** What happens to the metadata of uploaded pictures, whether they are shrunk or not. */
	imageMetadata: MetadataMode;
	toolbarPrompted: boolean;
	/** The set-up guide was offered for this vault (or was never needed). */
	setupDone: boolean;
	/** Keyhole took the paper clip out of the mobile toolbar (the user chose "instead of"), so it puts it back when it goes. */
	toolbarReplacesAttach: boolean;
	trashMovedAttachments: boolean;
	suggestMove: boolean;
	limitEditHeight: boolean;
	editMaxHeightPercent: number;
	fallbackToLocal: boolean;

	/** Encrypt new uploads. Reading encrypted files only needs the key on the device. */
	e2eEnabled: boolean;
	/** Non-secret fingerprint of the vault's encryption key; empty until encryption was set up. */
	e2eFingerprint: string;

	cacheEnabled: boolean;
	cacheMaxMB: number;
	cacheMaxFileMB: number;
	streamLargeMedia: boolean;
}

export const DEFAULT_SETTINGS: KeyholeSettings = {
	storageType: "s3",
	alias: "main",
	keyPrefix: "",

	s3Endpoint: "",
	s3Region: "auto",
	s3Bucket: "",
	s3PathStyle: true,
	s3AccessKeyId: "",
	s3SecretKeyRef: "",

	httpUrl: "",
	httpAuth: "bearer",
	httpUsername: "",
	httpSecretRef: "",

	uploadScope: "all",
	maxUploadMB: 100,
	optimizeImages: true,
	imageMaxEdge: 2560,
	imageQuality: 85,
	imageMetadata: "strip",
	toolbarPrompted: false,
	setupDone: false,
	toolbarReplacesAttach: false,
	trashMovedAttachments: true,
	suggestMove: true,
	limitEditHeight: true,
	editMaxHeightPercent: 50,
	fallbackToLocal: true,

	e2eEnabled: false,
	e2eFingerprint: "",

	cacheEnabled: true,
	cacheMaxMB: 500,
	cacheMaxFileMB: 25,
	streamLargeMedia: true,
};
