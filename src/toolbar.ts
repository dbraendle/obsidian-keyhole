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
