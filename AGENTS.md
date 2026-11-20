# Agent notes for obsidian-keyhole

- Package manager: pnpm. `pnpm check` = lint + tests + production build; it must pass before every commit.
- Lint with `eslint-plugin-obsidianmd` from the repo root (it also checks manifest.json and LICENSE). The community directory scanner runs the same rules.
- TypeScript stays on 6.x until typescript-eslint supports TS 7.
- No Node/Electron APIs in `src/` (the plugin runs on mobile). Network only through `requestUrl`.
- Never put secrets into settings (`data.json`): use `app.secretStorage` and store only the entry name.
- `src/storage/keyhole-sign.ts` and `server/src/sign.ts` must stay in sync; a test checks they agree.
- The link format `keyhole://<alias>/<key>` is a public contract. Changing it breaks users' notes.
- Releases: bump with `pnpm version <x.y.z>` (no "v" prefix), push the tag. The workflow waits for the maintainer's approval in the `release` environment, then publishes. Agents never approve that gate themselves and never merge external pull requests.
- E2E testing on desktop: launch a separate Obsidian instance with `--user-data-dir=<tmp> --remote-debugging-port=<port>` on a throwaway vault and drive it over the DevTools protocol. Never touch the user's real vaults.
