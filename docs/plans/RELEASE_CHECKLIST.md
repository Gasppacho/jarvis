# Release Checklist

## Build

- [ ] Versions UI, Engine, API and database schema are recorded.
- [ ] TypeScript production bundle is reproducible.
- [ ] Official Node.js LTS binary and native addons match arm64 target.
- [ ] Contracts, migrations and official modules are included.
- [ ] No dev-only tokens, fixtures or `.env` files are bundled.

## Tests

- [ ] All CI gates pass.
- [ ] Application Harness reference workflow passes.
- [ ] Migration tests pass from previous released version.
- [ ] Bundle smoke test launches Engine and displays health.
- [ ] GitHub sandbox test creates exactly one PR.
- [ ] Crash recovery and replay tests pass.

## Security and signing

- [ ] Nested binaries are signed before the app bundle.
- [ ] Hardened runtime entitlements are minimal and reviewed.
- [ ] Keychain and repository grants work on a clean account.
- [ ] DMG and app are notarized and ticket stapled.
- [ ] `spctl` and `codesign --verify --deep --strict` pass.
- [ ] Diagnostic export contains no secret.

## Product

- [ ] Fresh install wizard is usable without terminal setup.
- [ ] Upgrade preserves projects, bindings and history.
- [ ] Release notes list migrations and known limitations.
- [ ] Uninstall/data removal instructions are documented.
