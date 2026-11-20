import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import globals from "globals";

// The reference server in server/ is a Node program, not plugin code:
// Obsidian-specific rules do not apply there.
const pluginOnly = (config) => ({ ...config, ignores: [...(config.ignores ?? []), "server/**"] });

export default defineConfig([
	globalIgnores(["node_modules", "dist", "main.js", "esbuild.config.mjs", "version-bump.mjs", "coverage"]),
	...obsidianmd.configs.recommended.map(pluginOnly),
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts"],
				},
			},
		},
	},
	{
		files: ["server/**/*.ts"],
		extends: [tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			globals: globals.node,
			parserOptions: {
				projectService: false,
				project: "./server/tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Node scripts outside the plugin bundle may use fetch.
		files: ["test/integration/**/*.ts"],
		rules: { "no-restricted-globals": "off" },
	},
	{
		// node:test's test() returns a promise the runner tracks itself.
		files: ["server/test/**/*.ts"],
		rules: { "@typescript-eslint/no-floating-promises": "off" },
	},
]);
