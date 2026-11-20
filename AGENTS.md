# Agent notes for obsidian-keyhole

- Package manager: pnpm. `pnpm check` = lint + tests + production build; it must pass before every commit.
- Lint with `eslint-plugin-obsidianmd` from the repo root (it also checks manifest.json and LICENSE). The community directory scanner runs the same rules.
- TypeScript stays on 6.x until typescript-eslint supports TS 7.
- No Node/Electron APIs in `src/` (the plugin runs on mobile). Network only through `requestUrl`.
- Never put secrets into settings (`data.json`): use `app.secretStorage` and store only the entry name.
- `src/storage/keyhole-sign.ts` and `server/src/sign.ts` must stay in sync; a test checks they agree.
- The link format `keyhole://<alias>/<key>` is a public contract. Changing it breaks users' notes.
- Workflow: never push to `main` directly. Work on a branch (`feat/…`, `fix/…`, `ci/…`), open a pull request, wait for green CI, then squash-merge. External pull requests never merge without the maintainer.
- Releases are automatic: a push to `main` whose `manifest.json` version has no GitHub release yet publishes it (plugin files + server image). To ship, bump the version in the pull request with `pnpm version <patch|minor> --no-git-tag-version` (updates package.json, manifest.json, versions.json). No bump, no release.
- E2E testing on desktop: launch a separate Obsidian instance with `--user-data-dir=<tmp> --remote-debugging-port=<port>` on a throwaway vault and drive it over the DevTools protocol. Never touch the user's real vaults.
