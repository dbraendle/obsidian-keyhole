# Agent notes for obsidian-keyhole

- Package manager: pnpm. `pnpm check` = lint + tests + production build; it must pass before every commit.
- Lint with `eslint-plugin-obsidianmd` from the repo root (it also checks manifest.json and LICENSE). The community directory scanner runs the same rules.
- TypeScript stays on 6.x until typescript-eslint supports TS 7.
- No Node/Electron APIs in `src/` (the plugin runs on mobile). Network only through `requestUrl`.
- Never put secrets into settings (`data.json`): use `app.secretStorage` and store only the entry name.
- The Keyhole server lives in its own repository (dbraendle/keyhole-server). `src/storage/keyhole-sign.ts` must produce the same signatures as its `src/sign.ts`: both repositories test the same fixed vector (`test/misc.test.ts` here). Changing the scheme breaks every installed server.
- The link format `keyhole://<alias>/<key>` is a public contract. Changing it breaks users' notes. For encrypted files the fragment (`#photo.jpg`) carries the file name; it is part of the contract too.
- The encrypted file format "KHE1" and the key text `keyhole-key-v1:…` (`src/e2e/format.ts`) are contracts as well: files written today must stay readable forever. Never change them in place; add a new version next to them.
- Workflow: never push to `main` directly. Work on a branch (`feat/…`, `fix/…`, `ci/…`), open a pull request, wait for green CI, then squash-merge. External pull requests never merge without the maintainer.
- Releases are automatic: a push to `main` whose `manifest.json` version has no GitHub release yet publishes it (the plugin files). To ship, bump the version in the pull request with `npm version <patch|minor> --no-git-tag-version` (pnpm version does not run the bump script) (updates package.json, manifest.json, versions.json). No bump, no release.
- The website lives in `site/` (hand-written HTML and CSS, no JavaScript, no build step, nothing loaded from third parties). It uses the screenshots in `docs/listing/` directly. `scripts/assemble-site.sh` puts both together and fills in the site address (the one constant); `scripts/check-site.sh` validates the result. `.github/workflows/pages.yml` deploys it to GitHub Pages on pushes to `main` that touch it; it never publishes a plugin release.
- E2E testing on desktop: launch a separate Obsidian instance with `--user-data-dir=<tmp> --remote-debugging-port=<port>` on a throwaway vault and drive it over the DevTools protocol. Never touch the user's real vaults.
