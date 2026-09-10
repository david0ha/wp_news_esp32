# Local iOS release to TestFlight

Build an App Store IPA on a Mac, then upload that exact artifact with EAS Submit.
Local compilation does not consume an EAS cloud-build allocation. EAS Submit still needs
an authenticated Expo account and valid App Store Connect credentials.

Run commands from `app/`. Replace placeholders with values verified for this release;
keep local paths, Apple identifiers and credentials outside the repository. This is a
runbook, not an unattended script: stop at failed checks and preserve the relevant log.

**`tools/release-ios.py` now performs this whole sequence**, including both repairs below, and
refuses to submit an artifact whose own signature is not what was asked for:

```sh
tools/release-ios.py                          # archive, export, verify
ASC_APP_ID=<numeric app id> tools/release-ios.py --submit
```

Prefer it. This page remains the account of *why* each step is there and is what to read when the
script fails; `.claude/skills/release-ios/SKILL.md` is the same procedure in the shape an agent
picks up. Two things the script settles that this page left to the operator:

- **The credentials need no interactive session.** The App Store provisioning profile and the
  distribution certificate — p12 and password — can be read from EAS over its GraphQL API with the
  Expo session already on disk, so the temporary-keychain repair below runs unattended. `eas
  credentials` is not the only route to them.
- **Two environment variables belong on every `eas` invocation here.** `EXPO_NO_KEYCHAIN=1`,
  because this machine's login keychain refuses non-interactive access and every Apple sign-in
  otherwise dies at `Security returned a non-successful error code: 36` — which is `security
  add-generic-password`'s status truncated to a byte (`errSecInteractionNotAllowed`, −25308) and
  reads like a wrong password. And `EXPO_APPLE_TEAM_ID=<team>`, because the ASC API key stored on
  EAS records no team: without it eas-cli prompts, fails, and then **silently skips validating the
  provisioning profile on Apple's servers**.

## Prepare the source, native project and build number

Record `git rev-parse HEAD`, `git status --short`, `xcode-select -p` and `xcodebuild -version`.
Use the intended source commit and inspect existing changes before generating native files.
An old ignored `ios/` directory can belong to a different commit; it is not proof that
the current Expo configuration was applied.

```sh
npm ci
npm test -- --runInBand
npm run typecheck
npx expo prebuild --platform ios --no-install
(cd ios && pod install)
eas build:version:get -p ios --profile production
```

If stale generated files remain, regenerate in a fresh checkout or back them up before
using a clean prebuild. Do not erase local native changes without inspecting them.
Recheck the generated entitlements and project settings after prebuild and pod install.
`EXPO_APPLE_TEAM_ID` can select the correct team for EAS validation with existing credentials;
it does not guarantee that all future credential creation can run without Apple login.

Read the marketing version from `app.json` (`expo.version`). Check the remote EAS number
and App Store Connect uploads, including submissions in progress. With no concurrent
release, choose the next unused integer above both, normally remote + 1. Reserve it with
`eas build:version:set -p ios --profile production` and verify with `build:version:get`.
Do not later decrease this counter. Coordinate with any other release operator.

EAS `autoIncrement` applies to EAS Build, not a direct `xcodebuild`. The generated native
Info.plist is ignored by Git and may contain a stale literal `CFBundleVersion`. After
prebuild, set its values explicitly; a build-setting override alone may not replace literals:

```sh
MARKETING_VERSION="$(node -p 'require("./app.json").expo.version')"
BUILD_NUMBER='<reserved-unused-number>'
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING_VERSION" ios/ClaudePost/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" ios/ClaudePost/Info.plist
```

Prepare a unique `RELEASE_DIR` on a disk with enough room for archive, derived data and
export. An external SSD can hold these without holding Simulator data or runtimes.
A working Simulator build does not validate device distribution signing.

### External SSD storage and Simulator data

Treat these as separate locations: the Xcode application, DerivedData/Archives, the user's
`~/Library/Developer/CoreSimulator` directory, and system-managed Simulator runtime assets.
Moving Xcode or build output does not move the other locations. The user's CoreSimulator
directory can be copied to an external volume and its default path replaced with a symlink;
this is a local storage arrangement that must be rechecked after updates.

Use a mounted APFS volume with a stable mount path and enough room for both the live copy
and a retained backup. Set `SIM_DATA_SOURCE` to the resolved user CoreSimulator directory,
`SIM_DATA_TARGET` to a new directory on that volume, and `SIM_BACKUP_PATH` to a unique
backup path. Inspect any existing symlink and its target before moving anything.

1. Record `xcrun simctl list devices available` and the UDID of an existing device. Shut
   down the simulators, quit Simulator, and stop only the current user's CoreSimulator
   service. Ensure no build, Simulator, or update process is still writing to the source.
2. Copy with `ditto "$SIM_DATA_SOURCE" "$SIM_DATA_TARGET"`. Verify directory contents,
   file contents, symlinks, permissions and extended attributes before switching paths;
   a matching total size alone is insufficient. Retain the original as `SIM_BACKUP_PATH`.
3. Replace only the now-vacant default user CoreSimulator path with a symlink to the
   verified target. Check the link resolves to the mounted SSD, restart the user service,
   and boot the recorded UDID. Verify the existing device and its data are still present.
4. Build the app for that Simulator destination and install/launch it. Check available
   devices and runtimes again. Only after these checks pass, copy the original backup to
   a separate SSD backup directory, verify that copy, and remove the exact internal backup
   if reclaiming space is required. Keep the backup for rollback.

If validation fails, shut down Simulator and its user service again, remove only the link
created by this migration and restore the original directory from the verified backup.
Do not run Simulator or Xcode updates with the SSD disconnected: a broken link may prevent
startup, and tools may recreate internal directories. Before and after updates, recheck
the selected Xcode, mount path, symlinks, available runtimes, existing-device boot and app
build/install. This arrangement does not guarantee that every future update preserves it.

External-volume access is also controlled by macOS privacy permissions. If existing devices
disappear after linking and CoreSimulator logs report `Operation not permitted`, inspect
the TCC log for `kTCCServiceSystemPolicyRemovableVolumes` and the responsible process.
The service may be attributed to `com.apple.CoreSimulator.CoreSimulatorService` separately
from the Simulator application. A user must grant the required access in macOS Privacy &
Security; changing file modes does not grant it. Do not edit the TCC database or disable
privacy protection. Restore the original path while permission is pending, retain the SSD
copy, and repeat synchronization and validation after access is granted. Do not create
replacement devices or report reclaimed internal space before migration validation passes.

Modern runtime MobileAsset storage under SIP-protected `/System/Library/AssetsV2` and
system Simulator dyld caches are separate from user device data. Leave their placement to
macOS; do not disable SIP or replace system storage directories with links. The installed
Xcode tools expose no supported external runtime-install destination:
`xcrun simctl runtime add --move` imports into secure storage and removes the source image
after success; it does not choose an installation volume. Likewise,
`xcodebuild -downloadPlatform iOS -exportPath <directory>` chooses a download location,
not the location of the installed runtime. Check `xcrun simctl help runtime` and
`xcodebuild -help` again when the toolchain changes.

## Repair only the signing failure you have evidence for

### Profile rejected for missing Push Notifications

For `doesn't include the Push Notifications capability`, first check the selected team's
profile expiration, bundle ID, distribution certificate/private-key identity and
`Entitlements.aps-environment`. Decode the actual profile with
`security cms -D -i "$PROFILE_PATH"`; keep its output private. Check the target's generated
entitlements and which profile the failed archive command actually selected.

When those match, inspect this exact version-and-team cache file:

```text
~/Library/Developer/Xcode/UserData/Capabilities/capabilities-<XCODE_VERSION>-<IOS_TEAM_ID>-bundle.json
```

In the verified incident, that cache omitted `PUSH_NOTIFICATIONS` even though the profile
allowed production APNs. Preserve a copy for diagnosis and move only that confirmed bad
file into a unique backup directory outside the Capabilities directory. Retry the same
archive inputs and compare the result. Do not delete all Xcode caches or rotate certificates
as the first response. Keep the bad cache quarantined after confirmation; restoring it
reintroduced the error. If Xcode recreates it, inspect the new contents.

### Framework signing fails with `errSecInternalComponent`

This was a second failure after the capability check passed. A certificate listed in a
keychain does not prove that unattended codesign can use its private key. Confirm the
identity with `security find-identity -v -p codesigning` and inspect the first signing error.

For this incident, importing the existing EAS distribution certificate and private key
into a new unlocked temporary keychain fixed signing. Do not revoke or regenerate the
existing certificate. Obtain its password-protected export through the authenticated EAS
credentials workflow and keep it in a private temporary directory, outside Git.

Before changing keychains, capture the complete ordered user search list from
`security list-keychains -d user`. Arrange cleanup for success, failure and interruption.
Create a unique temporary keychain, unlock it and allow enough unlocked time for the build.
Import the existing certificate with signing-tool ACL access (`security import` with
`-T /usr/bin/codesign` and `-T /usr/bin/security`), then set the imported key's partition list
to `apple-tool:,apple:,codesign:` using `security set-key-partition-list`.
Apply this only to the isolated temporary keychain, not every key in the login keychain.

Supply passwords through a private secret-handling session; do not paste literal secrets
into commands, shell history, logs or committed files. Disable command tracing and avoid
logging credential-tool output. Use secure prompts where supported; commands requiring
password arguments need an execution context that does not record those arguments.

Add the temporary keychain to the saved search list without dropping or reordering its
existing entries. Verify its identity, and pass its path to archive via
`OTHER_CODE_SIGN_FLAGS`. Keep it unlocked and searchable through export as well.
The variable `KEYCHAIN_PATH` below refers only to that newly created keychain.

## Archive and export

Set `IOS_TEAM_ID`, `PROFILE_UUID`, `SIGNING_IDENTITY`, `RELEASE_DIR` and `KEYCHAIN_PATH`
from the verified local credentials and paths. Use the exact identity name or certificate
fingerprint; this incident used an existing `iPhone Distribution` identity. The selected
distribution profile must already be installed for Xcode to resolve its UUID.

```sh
set -o pipefail
xcodebuild -workspace ios/ClaudePost.xcworkspace -scheme ClaudePost \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$RELEASE_DIR/ClaudePost.xcarchive" \
  -derivedDataPath "$RELEASE_DIR/DerivedData" \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$SIGNING_IDENTITY" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_UUID" \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN_PATH" \
  archive 2>&1 | tee "$RELEASE_DIR/archive.log"
```

Require exit 0 and archive success. Create `export-options.plist` in `RELEASE_DIR` with
the following template, replacing placeholders with actual values (XML does not expand
shell variables). For additional signed targets, include their bundle/profile mappings.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>IOS_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>SIGNING_IDENTITY</string>
  <key>provisioningProfiles</key><dict>
    <key>com.claudepost.app</key><string>PROFILE_UUID</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
```

```sh
xcodebuild -exportArchive -archivePath "$RELEASE_DIR/ClaudePost.xcarchive" \
  -exportPath "$RELEASE_DIR/export" \
  -exportOptionsPlist "$RELEASE_DIR/export-options.plist" \
  2>&1 | tee "$RELEASE_DIR/export.log"
```

Require export exit 0. Unpack the IPA into a new verification directory, then check both
the archive app and exported app Info.plist: bundle ID, `CFBundleShortVersionString`, and
`CFBundleVersion` must match the intended release. Record the IPA SHA-256.
Inspect the exported executable's signed entitlements with
`codesign -d --entitlements - <App.app>/<Executable>`:
expect the intended team, `aps-environment=production` and `get-task-allow=false`.
If codesign reports an entitlement parsing warning, that output is inconclusive; inspect
the executable signature independently before asserting an APNs environment. The embedded
profile and generated source entitlements alone do not prove final signed entitlements.

## Submit the exact IPA and clean up

Verify the existing App Store Connect app and EAS API-key credentials. For noninteractive
submission, temporarily set `submit.production.ios.ascAppId` in `eas.json` to that app's ID.
Record the original file and any pre-existing edits first. Apple identifiers remain local.

```sh
eas submit -p ios --profile production \
  --path "$RELEASE_DIR/export/ClaudePost.ipa" --non-interactive --wait
```

Use `--path`, never `--latest`, for this local artifact. Require a successful submission
status and save the submission URL/ID privately. Restore only the submission-specific
configuration change, preserving any pre-existing work. Restore the exact original
keychain search list, then delete only the temporary keychain created for this release and
its downloaded private credential copies. Keep the archive, IPA, sanitized evidence and
quarantined capability cache. Verify cleanup and `git status --short` even after failures.

Report these outcomes separately: local archive/export passed; EAS uploaded to Apple;
Apple finished processing and the build is available in TestFlight. Upload success only
proves the second outcome. Push delivery needs a device test and Expo push receipt from
the installed build; production entitlements alone do not establish delivery.

## Verified incident: 2026-09-09

The private release directory's `release-notes.md`, archive/export logs and submission log
recorded source `841e195c57b6ddb46ff0bc5140969a4c80b11be8`, version **1.8.0 (26)**,
Xcode **26.5 (17F42)**, **42 Jest suites / 994 tests** and TypeScript passing. Both local
archive and export succeeded after the two repairs above. The EAS remote iOS counter moved
from 25 to 26. The exported executable was independently verified with production APNs
and `get-task-allow=false`.

The IPA SHA-256 was `74c87ce9f01f347e3997f4732f287d3c2649f7e405510f2d5d142d4ba31f625d`.
EAS submission `754b3f6f-78ad-4df5-b535-5b11a3dcb074` succeeded; find it in the project's
Expo submissions dashboard. Apple processing was still pending at handoff, so TestFlight
availability and push delivery were not confirmed. These are historical artifact values,
not instructions to reuse version 26 or assume the current branch has version 1.8.0.

The comparison IPA **1.7.0 (20)** was already signed for **production APNs**, built with
**Xcode 26.4.1**, and came from a different commit. Earlier claims that it used Xcode 16,
that all previous releases used sandbox APNs, or that Xcode 26.5 could not build this
project were incorrect. Source `aps-environment=development` alone cannot establish the
environment of an exported distribution signature.

## Verified incident: 2026-09-10

Version **1.9.0 (27)** from `9cf593c18fb61e61ffb91c63b84ed4eb6513de46`, Xcode 26.5 (17F42), 43
Jest suites / 1006 tests and TypeScript passing. The exported executable's own signature carried
`aps-environment=production`, `get-task-allow=false` and the expected team; the archive and the
exported `Info.plist` agreed on 1.9.0 / 27. IPA SHA-256
`956e68c524a23556747ffa7350fa0863d410193a00c92f1aa24ad16d120fcfdd`. EAS submission
`1a5c54d2-e798-4a5b-ad9c-4e61a085f721` succeeded; Apple's processing was still pending at handoff,
so TestFlight availability and push delivery were again not confirmed. The EAS remote counter was
NOT advanced — `eas build:version:set` needs a terminal, and it was left for the operator.

What this release added to the two repairs above:

1. The capability-cache quarantine from 2026-09-09 was still in force and no push-capability
   rejection appeared, which is the first evidence that the repair holds across releases rather
   than having been a one-off.
2. Framework signing failed with `errSecInternalComponent` again, exactly as documented — the
   temporary keychain is not a one-time fix but a step of every local release on this machine,
   because the previous one is deleted during cleanup by design.

And one mistake worth the next reader's time. The first attempt piped `xcodebuild` through
`tee | tail`. A pipeline's exit status is its **last** command's, so `set -e` never fired, the
archive's signing failure was swallowed, and the run continued to the export — which reported
`archive not found at path …`. Fifty thousand log lines separated the message from its cause, and
the message described a missing file for what was a signing failure. This page already said
`set -o pipefail`; that line is load-bearing, and `tools/release-ios.py` avoids pipelines for
`xcodebuild` entirely rather than relying on remembering it.
