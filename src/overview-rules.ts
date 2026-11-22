/** Pure helpers for the file overview (testable without Obsidian). */

export interface LocalEntry {
	name: string;
	size: number;
	/** Number of notes that link to the file. */
	notes: number;
}

/** Largest first: those are the files worth moving. Equal sizes go by name. */
export function sortLocal<T extends LocalEntry>(rows: T[]): T[] {
	return [...rows].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

/** Rows whose name contains every word of the filter, ignoring case. */
export function filterByName<T extends { name: string }>(rows: T[], filter: string): T[] {
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return rows;
	return rows.filter((row) => {
		const name = row.name.toLowerCase();
		return words.every((word) => name.includes(word));
	});
}
