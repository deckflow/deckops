# Temporary upstream browser entry

`@deckops/sdk` is pinned to `0.8.0-next.0` while its browser-entry fix awaits a public upstream release. The pnpm patch adds `./browser` and its generated JavaScript/declarations; it leaves the published Node entry intact.

The source of the fix lives in the DeckOps repository, `sdks/typescript/src/browser.ts` and its shared/runtime modules. It separates Node filesystem/UUID code, propagates abort signals, makes guest fallback opt-in for the browser, and disables automatic mutation retries by default there.

This is a **build-time dependency patch**, not a consumer installation requirement. DeckParse's `tsup.browser.config.ts` bundles the browser runtime and resolves its declarations. `scripts/check-browser.mjs` checks the public package export, import-time SSR safety and absence of external runtime or SDK type dependencies. Node consumers keep using the unchanged upstream Node entry.

Rebuilding the patch after an upstream change:

1. Run the upstream SDK type checks/tests.
2. Use `pnpm patch @deckops/sdk@0.8.0-next.0` in this project to obtain an edit directory.
3. Build **only** upstream `src/browser.ts` as ESM with standalone declarations into that directory's `dist/`, without cleaning/replacing the existing Node files. Add `./browser` to its `package.json` exports. Do not change dependency versions inside the patch.
4. Run `pnpm patch-commit <edit-directory>`, then `pnpm check` and the real-browser smoke suite. Commit the patch, package manifest and lockfile together.

Once a tested upstream version ships this entry, replace the pinned version, remove the temporary patch through pnpm and rerun all checks. Do not replace this patch with a local sibling-repository dependency or require application developers to alias Node builtins.

The normal `pnpm install --frozen-lockfile` / `pnpm build` workflow needs neither the sibling repository nor an unpublished package.
