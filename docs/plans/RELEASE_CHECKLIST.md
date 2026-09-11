# Release Checklist

## Build

- [x] Versions UI, Engine, API and database schema are recorded in `dist/Jarvis.app/Contents/Resources/build-manifest.json` by [`scripts/build-app.sh`](../../scripts/build-app.sh) / [`scripts/build-manifest.mjs`](../../scripts/build-manifest.mjs) (`pnpm run build:app`).
- [ ] TypeScript production bundle is reproducible.
- [x] Official Node.js LTS binary and native addons match arm64 target ([`apps/engine/scripts/bundle-runtime.test.mjs`](../../apps/engine/scripts/bundle-runtime.test.mjs), `pnpm exec vitest run apps/engine/scripts/bundle-runtime.test.mjs`; local `dist/Jarvis.app` proof: `node --version` is `v24.16.0` and `file` reports arm64 for Node and `better_sqlite3.node`).
- [x] Contracts, migrations and official modules are included by [`scripts/build-app.sh`](../../scripts/build-app.sh) (clean declared-bundle case in [`apps/engine/test/build-app.integration.test.ts`](../../apps/engine/test/build-app.integration.test.ts)).
- [ ] No dev-only tokens, fixtures or `.env` files are bundled. The assembly gate proves the absence of known dev-only paths ([`apps/engine/test/build-app.integration.test.ts`](../../apps/engine/test/build-app.integration.test.ts)); a content-level secret audit is not part of this ticket. Close with a reviewed release artifact scan.

## Tests

- [ ] All CI gates pass.
- [ ] Application Harness reference workflow passes.
- [ ] Migration tests pass from previous released version.
- [x] Bundle smoke test launches Engine and displays health ([`scripts/smoke-bundle.sh`](../../scripts/smoke-bundle.sh), `bash scripts/smoke-bundle.sh --step launch`).
- [x] Bundle smoke test imports a local Git repository and rejects a plain directory ([`scripts/smoke-bundle.sh`](../../scripts/smoke-bundle.sh), `bash scripts/smoke-bundle.sh --step import`).
- [ ] GitHub sandbox test creates exactly one PR.
- [ ] Crash recovery and replay tests pass.
- [x] Packaged Engine crash recovery passes ([`scripts/smoke-bundle.sh`](../../scripts/smoke-bundle.sh), `bash scripts/smoke-bundle.sh --step recovery`: unclean kill, same-root relaunch, Project retained, schema unchanged and second Engine refused).
- [x] Packaging script seams pass (`bash scripts/build-dmg.test.sh`, `bash scripts/notarize-dmg.test.sh`, `bash scripts/release.test.sh`).

## Security and signing

- [x] Nested binaries are signed before the app bundle ([`scripts/sign-app.sh`](../../scripts/sign-app.sh), `bash scripts/sign-app.sh`; recursive `codesign --verify --deep --strict` passes locally, and [`scripts/sign-app.test.sh`](../../scripts/sign-app.test.sh) proves nested tampering fails verification).
- [x] Hardened runtime entitlements are minimal and reviewed ([`scripts/sign-app.sh`](../../scripts/sign-app.sh), [`scripts/jarvis-engine.entitlements.plist`](../../scripts/jarvis-engine.entitlements.plist)).
- [ ] Keychain and repository grants work on a clean account. Preuve manquante : aucun compte propre n'est disponible ; cette ligne se ferme avec l'installation et les smoke steps sur ce compte.
- [ ] DMG and app are notarized and ticket stapled. Preuve manquante : `notarize-dmg.sh` n'a pas pu appeler Apple sans credentials ; `scripts/notarize-dmg.test.sh` ne prouve que le seam simulé. Cette ligne se ferme avec le verdict Apple Accepted, le stapling et `xcrun stapler validate` sur la DMG publiée.
- [ ] `spctl` and `codesign --verify --deep --strict` pass. `codesign` est prouvé localement, mais Gatekeeper ne peut pas être conclu avec une signature ad hoc ; cette ligne se ferme sur la DMG notariée installée sur une machine propre.
- [ ] Diagnostic export contains no secret.

## Product

- [ ] Fresh install wizard is usable without terminal setup.
- [ ] Upgrade preserves projects, bindings and history.
- [ ] Release notes list migrations and known limitations.
- [ ] Uninstall/data removal instructions are documented.
