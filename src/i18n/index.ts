import { getLanguage } from "obsidian";
import { de } from "./de";
import { en, type TextKey } from "./en";

export type { TextKey };

/** Add a language: create a file like de.ts and register it here. */
const languages: Record<string, Partial<Record<TextKey, string>>> = { en, de };

let current: Partial<Record<TextKey, string>> = en;

/** Picks the texts for Obsidian's interface language (falls back to English). */
export function initLanguage(): void {
	const code = getLanguage().toLowerCase();
	current = languages[code] ?? languages[code.split("-")[0] ?? ""] ?? en;
}

/** Translated text with {placeholders} filled in. */
export function t(key: TextKey, vars: Record<string, string | number> = {}): string {
	const text = current[key] ?? en[key];
	return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
