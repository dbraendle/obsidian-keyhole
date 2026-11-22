import { Notice, type App } from "obsidian";
import { ConfirmModal } from "./files";
import { t } from "./i18n";
import type { Migrator } from "./migrate";
import { formatBytes } from "./migrate-rules";

/** How many attachments "move all" would take, and how large they are together. */
export function movableSummary(migrator: Migrator): { count: number; bytes: number } {
	const files = migrator.movable();
	return { count: files.length, bytes: files.reduce((sum, f) => sum + f.stat.size, 0) };
}

/** Moves every local attachment that notes show to the storage, with progress and a summary. */
export async function runMoveAll(migrator: Migrator, onDone?: () => void): Promise<void> {
	const files = migrator.movable();
	if (!files.length) {
		new Notice(t("moveAll.none"));
		return;
	}
	const notice = new Notice(t("moveAll.progress", { done: 0, count: files.length }), 0);
	const result = await migrator.moveAll(files, (done, count) => notice.setMessage(t("moveAll.progress", { done, count })));
	const parts = [t("move.result", { count: result.moved, before: formatBytes(result.before), after: formatBytes(result.after) })];
	if (result.trashed) parts.push(t("move.trashed", { count: result.trashed }));
	if (result.moved > result.trashed) parts.push(t("moveAll.kept", { count: result.moved - result.trashed }));
	if (result.skipped) parts.push(t("moveAll.skipped", { count: result.skipped }));
	if (result.failed.length) parts.push(t("move.failed", { list: result.failed.slice(0, 5).join(", ") + (result.failed.length > 5 ? " …" : "") }));
	notice.setMessage(parts.join(" "));
	window.setTimeout(() => notice.hide(), result.failed.length ? 20000 : 10000);
	onDone?.();
}

/** Asks first: this rewrites notes all over the vault. */
export function confirmMoveAll(app: App, migrator: Migrator, onDone?: () => void): void {
	const { count, bytes } = movableSummary(migrator);
	if (!count) {
		new Notice(t("moveAll.none"));
		return;
	}
	new ConfirmModal(app, t("moveAll.title"), t("moveAll.text", { count, size: formatBytes(bytes) }), t("moveAll.confirm"), () => runMoveAll(migrator, onDone)).open();
}
