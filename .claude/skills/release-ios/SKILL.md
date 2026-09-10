---
name: release-ios
description: Use when shipping the companion app (app/) to TestFlight — builds the IPA on this Mac and uploads that exact artifact with EAS Submit, which works even when the EAS cloud build allowance is spent. Also the place to look when an archive fails on provisioning or on errSecInternalComponent.
---

# release-ios — build here, submit to TestFlight

```sh
tools/release-ios.py                          # archive, export, verify — stop there
ASC_APP_ID=<numeric app id> tools/release-ios.py --submit
```

That is the whole procedure. The script does the gates, the prebuild, the version stamp, the two
repairs below, the archive, the export, the verification and the upload, and it cleans up after
itself on every exit path. [docs/app-testflight-release.md](../../../docs/app-testflight-release.md)
is the long-form runbook it automates — read that when something fails in a way this file does not
name.

**Why local rather than cloud.** EAS's free plan meters iOS *builds* monthly and that ceiling is
real. `eas submit` is **not** metered, so a local archive plus `eas submit --path` ships a release
when the allowance is spent, and it is the same artifact either way.

## Before you run it

- `eas whoami` must answer. If not, the login is the user's job: `! eas login`.
- **`ASC_APP_ID`** is the App Store Connect numeric app id. It is an Apple identifier and is
  deliberately not in this repository; it is visible on any past submission at expo.dev, and
  `--submit` refuses to start without it.
- **`RELEASE_DIR`** defaults under the system temp. An archive, DerivedData and the export come to
  about 8 GB — point it at a volume with room if the boot disk is tight.
- The marketing version comes from `app/app.json`. `appVersionSource: remote` autoincrements only
  the *build number*, so bump `version` there yourself, in the same PR as the feature, and never
  below what TestFlight already holds.

## What the script handles that a person would get wrong

- **The build number** is the EAS remote counter plus one, and it is stamped into the generated
  `Info.plist` with PlistBuddy. `autoIncrement` applies to EAS Build, not to a direct `xcodebuild`,
  and a build-setting override alone may not replace a literal the template left.
- **A stale capability cache.** Xcode caches a team's capability list per version at
  `~/Library/Developer/Xcode/UserData/Capabilities/capabilities-<xcode>-<team>-bundle.json`. When
  it omits `PUSH_NOTIFICATIONS` the archive fails with *"Provisioning profile … doesn't include the
  Push Notifications capability"* against a profile that plainly carries `aps-environment`. Four
  builds were spent on this before the cache was found. Only a cache actually missing the
  capability is quarantined, and it is moved rather than deleted.
- **`errSecInternalComponent` on framework signing.** A certificate that `security find-identity`
  lists is not a certificate unattended codesign can use: a login keychain that refuses
  non-interactive access blocks the private key. The script pulls the distribution certificate from
  EAS, imports it into a temporary keychain with `-T /usr/bin/codesign` and
  `set-key-partition-list`, and signs out of that — leaving the login keychain's own keys alone,
  which a blanket partition-list change would not.
- **The signing identity.** `expo prebuild` writes `CODE_SIGN_IDENTITY = "iPhone Developer"` into
  the *Release* configuration. Paired with an App Store profile, Xcode judges the profile in a
  development context and reports the mismatch as a missing capability.
- **Never a pipeline for `xcodebuild`.** A pipeline's exit status is its *last* command's, so
  `xcodebuild … | tee | tail` hides an archive failure entirely and the export then reports
  "archive not found" — a signing error described as a missing file, fifty thousand log lines away.
  The script redirects to a log file instead.
- **Verification reads the artifact, not the inputs.** The export *re-signs*, so neither
  `app.json` nor the embedded profile establishes the final entitlements. The script unpacks the
  IPA and reads the executable's own signature, and refuses to go on unless it is
  `aps-environment=production`, `get-task-allow=false`, and the version and build number asked for.
  Reading `aps-environment` out of source and calling a shipped build sandbox-signed is a mistake
  that has been made on this project.
- **`--path`, never `--latest`.** `--latest` means the newest EAS *cloud* build, which is not the
  artifact just built and may be a different commit.

## Environment for any `eas` command on this machine

The script sets these; a hand-run command needs them too.

| Variable | Why |
|---|---|
| `EXPO_NO_KEYCHAIN=1` | Without it every Apple sign-in dies at `Security returned a non-successful error code: 36` — which is `security add-generic-password`'s status truncated to a byte (`errSecInteractionNotAllowed`, −25308) and reads like a wrong password. |
| `EXPO_APPLE_TEAM_ID=<team>` | The ASC API key stored on EAS records no team, so eas-cli falls back to a prompt no non-interactive shell can answer — and then *silently skips* validating the profile on Apple's servers. |

Never attempt an interactive Apple login from an agent shell: there is no TTY, and even
`script -q /dev/null …` dies with `tcgetattr/ioctl`. Hand it to the user with `! eas …`.

## After a successful submit

1. **Reserve the build number.** `eas build:version:set` needs a TTY, so it cannot be run from an
   agent session — ask the user for `! cd app && eas build:version:set -p ios --profile production`
   and the number the script printed. Skipped, the remote counter stays behind what Apple now holds
   and the next cloud build autoincrements into a collision.
2. **Report the stages separately.** Local archive/export passing, EAS uploading to Apple, and
   Apple finishing processing are three different outcomes. Upload success proves only the second;
   TestFlight availability takes another five to ten minutes and must be checked. Push *delivery*
   is a fourth, and needs a device and an Expo push receipt — production entitlements do not
   establish it.
3. Commit the `app.json` version bump if it is not already on the branch.
