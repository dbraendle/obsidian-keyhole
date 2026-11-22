/**
 * The mobile editor toolbar is a core setting (`mobileToolbarCommands`) with no
 * public plugin API. Keyhole only touches it when the user agrees.
 */
export const UPLOAD_COMMAND_ID = "keyhole:upload-files";
export const ATTACH_COMMAND_ID = "editor:attach-file";

/** Moves (or inserts) `id` directly after the paper clip, or to the front if there is none. */
export function placeAfterAttach(commands: readonly string[], id: string = UPLOAD_COMMAND_ID): string[] {
	const list = commands.filter((c) => c !== id);
	const attach = list.indexOf(ATTACH_COMMAND_ID);
	list.splice(attach >= 0 ? attach + 1 : 0, 0, id);
	return list;
}

export function isPlacedAfterAttach(commands: readonly string[], id: string = UPLOAD_COMMAND_ID): boolean {
	const i = commands.indexOf(id);
	if (i < 0) return false;
	const attach = commands.indexOf(ATTACH_COMMAND_ID);
	return attach < 0 ? i === 0 : i === attach + 1;
}

/** Where the upload button is in the mobile toolbar. */
export type ToolbarMode = "off" | "beside" | "replace";

/** Puts the paper clip back, in the place of the upload button (or at the front). */
export function restoreAttach(commands: readonly string[], id: string = UPLOAD_COMMAND_ID): string[] {
	if (commands.includes(ATTACH_COMMAND_ID)) return [...commands];
	const list = [...commands];
	const at = list.indexOf(id);
	list.splice(at >= 0 ? at : 0, 0, ATTACH_COMMAND_ID);
	return list;
}

/** `removedAttach`: Keyhole took the paper clip out earlier, so it is Keyhole's to put back. */
export function toolbarMode(commands: readonly string[], removedAttach: boolean, id: string = UPLOAD_COMMAND_ID): ToolbarMode {
	if (!commands.includes(id)) return "off";
	return removedAttach && !commands.includes(ATTACH_COMMAND_ID) ? "replace" : "beside";
}

/**
 * The toolbar for the wanted mode. The paper clip only comes back if Keyhole removed
 * it (a user may have taken it out on purpose), and it only counts as removed by
 * Keyhole if it was there.
 */
export function applyToolbarMode(
	commands: readonly string[],
	mode: ToolbarMode,
	removedAttach: boolean,
	id: string = UPLOAD_COMMAND_ID,
): { commands: string[]; removedAttach: boolean } {
	const base = removedAttach ? restoreAttach(commands, id) : [...commands];
	if (mode === "off") return { commands: base.filter((c) => c !== id), removedAttach: false };
	const beside = placeAfterAttach(base, id);
	if (mode === "beside") return { commands: beside, removedAttach: false };
	const hadAttach = beside.includes(ATTACH_COMMAND_ID);
	return { commands: beside.filter((c) => c !== ATTACH_COMMAND_ID), removedAttach: hadAttach };
}
