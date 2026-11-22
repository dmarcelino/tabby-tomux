# AGENTS.md

tomux is a Tabby plugin: an Angular module that Tabby loads at runtime. It runs tmux in control mode and shows each tmux window as a native Tabby tab.
Upstream: https://github.com/Eugeny/tabby. Its docs are thin, so read its source (tabby-core, tabby-terminal, tabby-ssh) or the typings in `node_modules/tabby-*` for APIs.
User-facing behaviour and setup are in `README.md`.

## Commands
- Install: `npm ci`
- Build: `npm run build` (webpack → `dist/index.js`)
- Watch: `npm run watch`
- Test: `npm test` (vitest, `src/**/*.spec.ts`)
- Typecheck: `npm run typecheck`
- Run in Tabby: link the repo into Tabby's `plugins/node_modules/tabby-tomux` (see README, "Loading the plugin into Tabby"). Restart Tabby after each build. Check that `log.txt` in Tabby's data folder contains `tomux plugin loaded`. Don't use `TABBY_PLUGINS`.
- Start Tabby with `TOMUX_DEV=1` to expose `window.__tomuxDev` (injector, service) to DevTools scripts.

## Rules
- Everything listed in `externals` in `webpack.config.mjs` comes from the host at runtime. Never bundle it. Keep these packages in peerDependencies/devDependencies only.
- tabby-ssh is the exception: Tabby does not share its instance with plugins. Load it only through `src/tabbyAdapter.ts`, never with a plain `require('tabby-ssh')`.
- Use Tabby's public providers, registered with `multi: true` in `src/index.ts`. Any use of Tabby internals (hidden APIs, deep imports) goes in `src/tabbyAdapter.ts` and nowhere else.
- Angular (15) and RxJS (7) versions must match the Tabby release we target. Check upstream before upgrading any of them.
- Profile options get their defaults in `configDefaults` in `src/profileProvider.ts`.
- Keep the package name `tabby-tomux`, the `tabby-plugin` keyword and the `author` field in `package.json`. Tabby silently skips a plugin without `author`.
- Every source file starts with `// SPDX-License-Identifier: GPL-3.0-only`. A file ported from tmux-integrated keeps a header naming its origin and gets a line in `NOTICE`.
- The plugin must work on every OS Tabby runs on. tmux runs only on the remote host over Tabby's SSH, never as a local process.
- Planned work goes through OpenSpec (`openspec/changes/`). Tick off tasks in that change's `tasks.md` as you finish them.
- Public repo: no secrets, tokens, hostnames, internal URLs or personal paths in code, fixtures, docs or commit messages. Machine-specific settings go in `.env.local`, which git ignores.
- Don't bump the version or publish to npm unless asked.

## Done means
`npm run typecheck`, `npm test` and `npm run build` pass, and the build shows no new warnings. New behaviour comes with unit tests; `src/tmux/fakeTmux.testing.ts` stands in for tmux.
State whether you tested the change in a running Tabby against a real tmux. If you did, record the results in `doc/TESTING.md`. If you couldn't, say so.
