# Clean macOS release verification

This is the repeatable manual gate for issue #184. It verifies the exact
notarized DMG and the `Jarvis.app` copied from it, without relying on the build
checkout or developer tools.

## Current status

This procedure has not been run successfully yet. Do not check an item below
or attach placeholder output as evidence.

- [ ] A notarized, stapled DMG is available. The locally produced ad-hoc image
  is not acceptable evidence for Gatekeeper.
- [ ] A clean macOS account or machine has been selected and provisioned.

These are the unresolved prerequisites. The accepted run must record the
Gatekeeper output and all smoke-test output on issue #184.

## Inputs and isolation

Prepare the following before logging in to the clean account:

1. The accepted `Jarvis-<version>.dmg` from issue #183. Copy it without
   rebuilding or modifying it.
2. A copy of `scripts/smoke-bundle.sh` from the same source revision, stored
   outside any repository checkout, for example:
   `/tmp/jarvis-release-verification/scripts/smoke-bundle.sh`.
   Record its SHA-256. Passing `--app` makes the script independent of its
   source checkout.
3. An evidence directory on the clean account, for example:

   ```sh
   set -eu
   EVIDENCE="$HOME/Desktop/jarvis-release-evidence-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$EVIDENCE"
   ```

Do not copy the repository, `node_modules`, build output, signing identity,
notary credentials, or a pre-existing Jarvis data directory to the account.
Do not install anything during the run.

## 1. Assert the clean account

Run these checks before opening the DMG and save their output in
`$EVIDENCE/preflight.txt`:

```sh
{
  date -u
  sw_vers
  uname -m
  id -un
  printf '\nNode and package managers:\n'
  for tool in node npm pnpm yarn bun; do
    if command -v "$tool" >/dev/null 2>&1; then
      printf 'FAIL: %s resolves to %s\n' "$tool" "$(command -v "$tool")"
    else
      printf 'PASS: %s is not on PATH\n' "$tool"
    fi
  done
  printf '\nDeveloper tools:\n'
  if /usr/bin/xcode-select -p >/dev/null 2>&1; then
    printf 'FAIL: xcode-select has an active developer directory\n'
    /usr/bin/xcode-select -p
  else
    printf 'PASS: no active Xcode developer directory\n'
  fi
  for path in /Applications/Xcode.app /Library/Developer/CommandLineTools \
    "$HOME/.nvm" "$HOME/.volta" "$HOME/.asdf" "$HOME/.fnm" "$HOME/.bun"; do
    if [ -e "$path" ]; then
      printf 'FAIL: developer/runtime path exists: %s\n' "$path"
    else
      printf 'PASS: path absent: %s\n' "$path"
    fi
  done
  printf '\nRepository check:\n'
  find "$HOME" /Users/Shared -type d -name .git -prune -print 2>/dev/null || true
  find "$HOME" /Users/Shared -type f -name .git -print 2>/dev/null || true
  printf 'No output above means no Git metadata was found in the checked roots.\n'
  printf '\nBuild identities and keychains:\n'
  /usr/bin/security list-keychains -d user
  /usr/bin/security find-identity -v -p codesigning
  if /usr/bin/security find-certificate -a -c 'Developer ID Application' \
    >/dev/null 2>&1; then
    printf 'FAIL: Developer ID Application certificate is present\n'
  else
    printf 'PASS: no Developer ID Application certificate is present\n'
  fi
} 2>&1 | tee "$EVIDENCE/preflight.txt"
```

The account fails the gate if any Node/package manager, active developer
directory, repository metadata, or build certificate is found. For each
non-secret service/profile label used by the build machine, also run
`security find-generic-password -s '<label>'` and require a non-zero result;
never use `-w` or print a password. Record the labels checked, not their
values.

The smoke script uses `/usr/bin/git` to create its temporary import fixture.
If that executable is unavailable on the clean system, do not install Command
Line Tools to make the run pass: record the failed precondition and stop.

## 2. Assess and install the DMG

Record the artifact hash before opening it:

```sh
DMG="/path/to/Jarvis-<version>.dmg"
/usr/bin/shasum -a 256 "$DMG" | tee "$EVIDENCE/dmg-sha256.txt"
```

Assess the disk image before mounting it. A successful command must exit `0`
and report `accepted`; preserve both stdout and stderr:

```sh
if /usr/sbin/spctl --assess --type open \
  --context context:primary-signature --verbose=4 "$DMG" \
  >"$EVIDENCE/gatekeeper-dmg.txt" 2>&1; then
  printf 'spctl DMG exit=0\n' | tee -a "$EVIDENCE/gatekeeper-dmg.txt"
else
  status=$?
  printf 'spctl DMG exit=%s\n' "$status" | tee -a "$EVIDENCE/gatekeeper-dmg.txt"
  cat "$EVIDENCE/gatekeeper-dmg.txt"
  exit "$status"
fi
cat "$EVIDENCE/gatekeeper-dmg.txt"
```

In Finder, double-click the DMG, drag `Jarvis.app` to `/Applications`, eject
the image, and do not launch a copy from the mounted image.

Assess the installed app and save the result:

```sh
/usr/sbin/spctl --assess --type execute --verbose=4 /Applications/Jarvis.app \
  >"$EVIDENCE/gatekeeper-app.txt" 2>&1
status=$?
printf 'spctl app exit=%s\n' "$status" | tee -a "$EVIDENCE/gatekeeper-app.txt"
cat "$EVIDENCE/gatekeeper-app.txt"
test "$status" -eq 0
```

The DMG and the installed app must both be accepted. A local ad-hoc signature,
an un-stapled image, or a result that only works while online is not a pass.

## 3. Double-click launch

In Finder, double-click `/Applications/Jarvis.app`. Capture the first-run
prompt, if any, and click **Open** only for the ordinary first-run confirmation.
A warning that identifies the developer as unidentified, says the app is
damaged, or requires bypassing Gatekeeper is a failure. Record that the
installed app started, then quit it through its normal UI/menu action.

Do not use `node`, `pnpm`, a repository command, or a build-directory app to
replace this launch test.

## 4. Run the packaged smoke test

Use the copied script, not a repository checkout. The installed app is the
only app path supplied to it:

```sh
SMOKE="/tmp/jarvis-release-verification/scripts/smoke-bundle.sh"
test -x "$SMOKE"
shasum -a 256 "$SMOKE" | tee "$EVIDENCE/smoke-script-sha256.txt"
"$SMOKE" --help | tee "$EVIDENCE/smoke-help.txt"
```

Run and capture each required step. A non-zero exit status fails the release
gate; keep the complete output rather than replacing it with a handwritten
summary.

```sh
"$SMOKE" --app /Applications/Jarvis.app --step launch \
  2>&1 | tee "$EVIDENCE/smoke-launch.txt"

"$SMOKE" --app /Applications/Jarvis.app --step import \
  2>&1 | tee "$EVIDENCE/smoke-import.txt"
```

The launch output must prove the embedded Node runtime, ready health and
database, graceful shutdown, and no surviving Engine process. The import
output must prove project import/listing and rejection of a plain directory.

Recovery is a separate required step. Run it only if the copied script's help
output explicitly exposes `--step recovery`:

```sh
grep -F -- 'recovery' "$EVIDENCE/smoke-help.txt"
"$SMOKE" --app /Applications/Jarvis.app --step recovery \
  2>&1 | tee "$EVIDENCE/smoke-recovery.txt"
```

If `recovery` is not advertised, record `BLOCKED: smoke-bundle.sh has no
recovery step` and do not claim issue #184 complete. The recovery result must
show that an uncleanly killed Engine relaunches from the same data root, the
previously imported Project remains listed, a second Engine on that root is
refused, and the schema version is unchanged.

## 5. Evidence to attach to issue #184

Attach or link the following, with the artifact version and SHA-256 in the
comment:

- `preflight.txt`, including the clean-account assertions;
- `gatekeeper-dmg.txt` and `gatekeeper-app.txt`, including exit statuses;
- the DMG and smoke-script hashes;
- the Finder first-run/launch observation or screenshot;
- `smoke-launch.txt`, `smoke-import.txt`, and `smoke-recovery.txt`;
- macOS version, architecture, account name, and test date.

Never attach passwords, private keys, notary credentials, session tokens, or a
full keychain dump. If a command fails, attach the failure output and mark the
corresponding acceptance criterion failed or blocked.

## Unresolved prerequisites at authoring time

1. **Notarized image:** issue #183 still needs a Developer ID Application
   identity and notary credentials, then an accepted submission with a
   stapled ticket. Until that exists, Gatekeeper evidence for the release DMG
   cannot be collected.
2. **Clean account/machine:** no clean target has been selected or provisioned.
   The current development environment contains the repository and developer
   tooling and is not valid evidence for this procedure.

Issue #184 is complete only after both prerequisites are resolved and the
captured evidence above is recorded on the issue.
