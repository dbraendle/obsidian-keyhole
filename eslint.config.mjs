import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// site/ is the static website (HTML and CSS, published by .github/workflows/pages.yml), not plugin code.
	globalIgnores(["node_modules", "dist", "main.js", "esbuild.config.mjs", "version-bump.mjs", "coverage", "site", "_site"]),
	...obsidianmd.configs.recommended,
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
		// Node scripts outside the plugin bundle may use fetch.
		files: ["test/integration/**/*.ts"],
		rules: { "no-restricted-globals": "off" },
	},
]);
