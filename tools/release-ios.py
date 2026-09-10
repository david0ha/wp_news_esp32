#!/usr/bin/env python3
"""Build the companion app locally and hand the exact artifact to TestFlight.

    tools/release-ios.py                 # archive, export, verify — stop there
    tools/release-ios.py --submit        # ...and upload it
    tools/release-ios.py --build-number 42

WHY THIS EXISTS RATHER THAN A CLOUD BUILD. EAS's free plan meters iOS builds monthly and the
ceiling is real; `eas submit` is not metered. So a local archive plus `eas submit --path` ships a
release when the build allowance is spent, and it is the same artifact either way. The long-form
account — including two failures that cost a day between them — is
docs/app-testflight-release.md, which this script automates rather than replaces.

WHAT IT REFUSES TO GUESS. Nothing about this Apple account is written down here: the repository is
public. The distribution certificate, its password and the provisioning profile are fetched from
EAS at run time; the team id and the signing identity are read out of the profile. The one value
that cannot be discovered is the App Store Connect numeric app id, because `eas submit` needs it
before it can ask Apple anything — supply it as ASC_APP_ID when submitting.

    ASC_APP_ID=1234567890 tools/release-ios.py --submit

RELEASE_DIR defaults to a directory under the system temp; set it to a volume with room for an
archive, DerivedData and the export (about 8 GB) if the boot disk is tight.

Secrets are handled but never printed: the p12, its password and the temporary keychain's password
live in a 0700 directory for the length of the run and are deleted on every exit path, including
failure and interrupt. The keychain search list is restored exactly as it was found.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "app"
EAS_PROJECT_ID_KEY = ("expo", "extra", "eas", "projectId")
PROFILE_DIRS = [
    # Xcode 16 and later read the first; earlier versions and some tooling still write the second.
    # Both are populated so the archive resolves the profile whichever one Xcode consults.
    Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
    Path.home() / "Library/MobileDevice/Provisioning Profiles",
]
CAPABILITIES_DIR = Path.home() / "Library/Developer/Xcode/UserData/Capabilities"


# --------------------------------------------------------------------------- shell


def run(argv, *, cwd=None, env=None, capture=False, log: Path | None = None) -> str:
    """One command, checked. A pipeline is never used, because a pipeline's exit status is the
    LAST command's: piping xcodebuild through `tee | tail` once masked an archive failure entirely
    and reported "archive not found" from the export step fifty thousand lines later."""
    printable = " ".join(str(a) for a in argv[:6]) + (" …" if len(argv) > 6 else "")
    print(f"    $ {printable}", flush=True)
    if log is not None:
        with open(log, "wb") as f:
            p = subprocess.run(argv, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT)
        if p.returncode != 0:
            raise SystemExit(f"failed ({p.returncode}); log: {log}")
        return ""
    p = subprocess.run(
        argv, cwd=cwd, env=env,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        text=True,
    )
    if p.returncode != 0:
        if capture and p.stdout:
            print(p.stdout[-4000:], file=sys.stderr)
        raise SystemExit(f"failed ({p.returncode}): {printable}")
    return (p.stdout or "").strip()


def eas_env() -> dict:
    """The environment every `eas` call wants on a machine whose login keychain is locked.

    EXPO_NO_KEYCHAIN: without it an Apple sign-in dies at "Security returned a non-successful error
    code: 36", which is `security add-generic-password`'s exit status truncated to a byte
    (errSecInteractionNotAllowed, -25308) and reads like a wrong password.

    EXPO_APPLE_TEAM_ID: the ASC API key stored on EAS records no team, so eas-cli falls back to a
    prompt no non-interactive shell can answer — and then silently skips validating the profile on
    Apple's servers. Filled in from the profile once it has been read.
    """
    env = dict(os.environ)
    env["EXPO_NO_KEYCHAIN"] = "1"
    nvm = Path.home() / ".nvm/versions/node"
    if nvm.is_dir():                       # `eas` is usually only on the nvm PATH
        newest = sorted(nvm.iterdir())[-1] / "bin"
        env["PATH"] = f"{newest}:{env['PATH']}"
    return env


# --------------------------------------------------------------------------- EAS


def expo_session() -> str:
    state = Path.home() / ".expo/state.json"
    if not state.is_file():
        raise SystemExit("not logged in to Expo: run `eas login`")
    return json.load(open(state))["auth"]["sessionSecret"]


def graphql(query: str, variables: dict) -> dict:
    import urllib.request

    req = urllib.request.Request(
        "https://api.expo.dev/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={
            "content-type": "application/json",
            "expo-session": expo_session(),
            # Cloudflare 403s a request with no browser-shaped user agent.
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        },
    )
    body = json.load(urllib.request.urlopen(req))
    if body.get("errors"):
        raise SystemExit("EAS GraphQL: " + json.dumps(body["errors"])[:600])
    return body["data"]


CREDENTIALS_QUERY = """
query($appId: String!) {
  app { byId(appId: $appId) {
    iosAppCredentials {
      iosAppBuildCredentialsList {
        iosDistributionType
        provisioningProfile { provisioningProfile }
        distributionCertificate { certificateP12 certificatePassword }
      }
    }
  } }
}
"""


def project_id() -> str:
    cfg = json.load(open(APP / "app.json"))
    node = cfg
    for key in EAS_PROJECT_ID_KEY:
        node = node[key]
    return node


def fetch_credentials(private: Path) -> dict:
    """The App Store profile and certificate EAS holds, onto disk in a private directory.

    `eas credentials` is interactive; this is the same data over the API so a release needs no
    prompt. Everything written here is deleted by `cleanup`.
    """
    data = graphql(CREDENTIALS_QUERY, {"appId": project_id()})
    for creds in data["app"]["byId"]["iosAppCredentials"]:
        for build in creds["iosAppBuildCredentialsList"]:
            if build["iosDistributionType"] != "APP_STORE":
                continue
            profile = build.get("provisioningProfile")
            cert = build.get("distributionCertificate")
            if not profile or not cert:
                continue
            p12 = private / "dist.p12"
            p12.write_bytes(base64.b64decode(cert["certificateP12"]))
            p12.chmod(0o600)
            pw = private / "dist.pw"
            pw.write_text(cert["certificatePassword"])
            pw.chmod(0o600)
            mp = private / "profile.mobileprovision"
            mp.write_bytes(base64.b64decode(profile["provisioningProfile"]))
            mp.chmod(0o600)
            return {"p12": p12, "p12_password": pw, "profile": mp}
    raise SystemExit("EAS holds no App Store distribution credentials for this project")


def read_profile(path: Path) -> dict:
    """A .mobileprovision is a CMS envelope; `security cms -D` unwraps it to the plist."""
    xml = subprocess.run(
        ["security", "cms", "-D", "-i", str(path)], capture_output=True, check=True
    ).stdout
    return plistlib.loads(xml)


# --------------------------------------------------------------------------- repairs


def quarantine_stale_capability_cache(release_dir: Path, team: str) -> None:
    """Xcode caches a team's capability list per version, and a stale one is reported as a lie.

    An archive fails with `Provisioning profile "…" doesn't include the Push Notifications
    capability` against a profile that demonstrably carries `aps-environment` — because Xcode is
    reading this file rather than the profile. Only a cache that is actually missing the capability
    is moved, and it is moved rather than deleted so the diagnosis survives.
    """
    xcode_version = ""
    for line in run(["xcodebuild", "-version"], capture=True).splitlines():
        if line.startswith("Xcode "):
            xcode_version = line.split()[1]
    if not xcode_version:
        return
    cache = CAPABILITIES_DIR / f"capabilities-{xcode_version}-{team}-bundle.json"
    if not cache.is_file():
        return
    try:
        text = cache.read_text()
    except OSError:
        return
    if "PUSH_NOTIFICATIONS" in text:
        return
    backup = release_dir / "capability-cache-backup"
    backup.mkdir(parents=True, exist_ok=True)
    shutil.move(str(cache), str(backup / cache.name))
    print(f"    quarantined a capability cache with no PUSH_NOTIFICATIONS -> {backup / cache.name}")


class Keychain:
    """A keychain of this run's own, holding one certificate, that codesign can actually use.

    A certificate listed by `security find-identity` does not prove unattended codesign can reach
    its private key: on a machine whose login keychain refuses non-interactive access, framework
    signing fails with `errSecInternalComponent` while the identity lists perfectly. An isolated
    keychain, created unlocked here with signing-tool ACL access, is the documented repair — and it
    leaves the login keychain's own keys alone, which a blanket `set-key-partition-list` would not.
    """

    def __init__(self, private: Path):
        self.path = private / "release.keychain"
        self.password = secrets.token_urlsafe(24)
        self.original_list: list[str] = []

    def open(self, p12: Path, p12_password: str) -> None:
        self.original_list = [
            line.strip().strip('"')
            for line in run(["security", "list-keychains", "-d", "user"], capture=True).splitlines()
            if line.strip()
        ]
        subprocess.run(["security", "delete-keychain", str(self.path)], capture_output=True)
        run(["security", "create-keychain", "-p", self.password, str(self.path)])
        run(["security", "unlock-keychain", "-p", self.password, str(self.path)])
        # No idle timeout and no lock-on-sleep: an archive takes minutes, and a keychain that
        # relocks half way through fails in exactly the way this class exists to prevent.
        run(["security", "set-keychain-settings", str(self.path)])
        run([
            "security", "import", str(p12), "-k", str(self.path), "-P", p12_password,
            "-f", "pkcs12", "-T", "/usr/bin/codesign", "-T", "/usr/bin/security",
        ], capture=True)
        run([
            "security", "set-key-partition-list",
            "-S", "apple-tool:,apple:,codesign:", "-s", "-k", self.password, str(self.path),
        ], capture=True)
        # Prepended, never replacing: dropping the user's other keychains for the length of a build
        # is a side effect nobody asked for.
        run(["security", "list-keychains", "-d", "user", "-s", str(self.path), *self.original_list])

    def close(self) -> None:
        if self.original_list:
            subprocess.run(
                ["security", "list-keychains", "-d", "user", *self.original_list],
                capture_output=True,
            )
        subprocess.run(["security", "delete-keychain", str(self.path)], capture_output=True)


# --------------------------------------------------------------------------- steps


def gates() -> None:
    print("== gates")
    run(["npm", "test", "--silent", "--", "--runInBand"], cwd=APP, env=eas_env())
    run(["npm", "run", "typecheck"], cwd=APP, env=eas_env())


def next_build_number(env: dict) -> int:
    out = run(
        ["eas", "build:version:get", "-p", "ios", "--profile", "production"],
        cwd=APP, env=env, capture=True,
    )
    m = re.search(r"buildNumber\s*-\s*(\d+)", out)
    if not m:
        raise SystemExit("could not read the remote build number:\n" + out[-800:])
    return int(m.group(1)) + 1


def prebuild(marketing: str, build_number: int) -> None:
    print("== native project")
    run(["npx", "expo", "prebuild", "--platform", "ios", "--no-install", "--clean"],
        cwd=APP, env=eas_env())
    run(["pod", "install"], cwd=APP / "ios")
    # EAS's autoIncrement applies to EAS Build, not to a direct xcodebuild, and the generated
    # Info.plist is gitignored — so whatever literals prebuild left are stale by definition. A
    # build-setting override alone may not replace a literal, which is why this edits the file.
    plist = APP / "ios/ClaudePost/Info.plist"
    run(["/usr/libexec/PlistBuddy", "-c",
         f"Set :CFBundleShortVersionString {marketing}", str(plist)])
    run(["/usr/libexec/PlistBuddy", "-c", f"Set :CFBundleVersion {build_number}", str(plist)])


def install_profile(path: Path, uuid: str) -> None:
    for d in PROFILE_DIRS:
        d.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, d / f"{uuid}.mobileprovision")


def archive_and_export(release_dir: Path, keychain: Keychain, profile: dict) -> Path:
    team = profile["Entitlements"]["com.apple.developer.team-identifier"]
    identity = subject_common_name(profile)
    uuid = profile["UUID"]

    print("== archive")
    run([
        "xcodebuild", "-workspace", "ios/ClaudePost.xcworkspace", "-scheme", "ClaudePost",
        "-configuration", "Release", "-destination", "generic/platform=iOS",
        "-archivePath", str(release_dir / "ClaudePost.xcarchive"),
        "-derivedDataPath", str(release_dir / "DerivedData"),
        f"DEVELOPMENT_TEAM={team}", "CODE_SIGN_STYLE=Manual",
        # prebuild writes "iPhone Developer" into the Release configuration. Left alone, Xcode
        # judges an App Store profile in a development context and reports the mismatch as a
        # missing capability.
        f"CODE_SIGN_IDENTITY={identity}",
        f"PROVISIONING_PROFILE_SPECIFIER={uuid}",
        f"OTHER_CODE_SIGN_FLAGS=--keychain {keychain.path}",
        "archive",
    ], cwd=APP, log=release_dir / "archive.log")

    options = release_dir / "export-options.plist"
    plistlib.dump({
        "method": "app-store-connect",
        "destination": "export",
        "teamID": team,
        "signingStyle": "manual",
        "signingCertificate": identity,
        "provisioningProfiles": {bundle_id(profile): uuid},
        # The versions were stamped above and are the release's; letting Xcode manage them here
        # would quietly hand Apple a different build number than the archive carries.
        "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
    }, open(options, "wb"))

    print("== export")
    export = release_dir / "export"
    shutil.rmtree(export, ignore_errors=True)
    run([
        "xcodebuild", "-exportArchive",
        "-archivePath", str(release_dir / "ClaudePost.xcarchive"),
        "-exportPath", str(export),
        "-exportOptionsPlist", str(options),
    ], cwd=APP, log=release_dir / "export.log")
    ipa = export / "ClaudePost.ipa"
    if not ipa.is_file():
        raise SystemExit(f"export produced no IPA; log: {release_dir / 'export.log'}")
    return ipa


def subject_common_name(profile: dict) -> str:
    der = profile["DeveloperCertificates"][0]
    subject = subprocess.run(
        ["openssl", "x509", "-inform", "DER", "-noout", "-subject"],
        input=der, capture_output=True, check=True,
    ).stdout.decode()
    m = re.search(r"CN\s*=\s*([^,/\n]+)", subject)
    if not m:
        raise SystemExit("could not read the certificate's common name from the profile")
    return m.group(1).strip()


def bundle_id(profile: dict) -> str:
    app_id = profile["Entitlements"]["application-identifier"]
    return app_id.split(".", 1)[1]


def verify(release_dir: Path, ipa: Path, marketing: str, build_number: int) -> str:
    """What the artifact IS, read from the artifact.

    The export re-signs, so neither the source entitlements nor the embedded profile establish the
    final signature — reading `aps-environment` out of `app.json` and calling a build sandbox-signed
    is a mistake that has been made on this project. The executable's own signature is the fact.
    """
    print("== verify")
    out = release_dir / "ipa-verification"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    with zipfile.ZipFile(ipa) as z:
        z.extractall(out)
    app_dir = next((out / "Payload").glob("*.app"))
    info = plistlib.loads((app_dir / "Info.plist").read_bytes())

    problems = []
    if info["CFBundleShortVersionString"] != marketing:
        problems.append(f"exported CFBundleShortVersionString {info['CFBundleShortVersionString']!r}")
    if info["CFBundleVersion"] != str(build_number):
        problems.append(f"exported CFBundleVersion {info['CFBundleVersion']!r}")

    executable = app_dir / info["CFBundleExecutable"]
    ent_xml = subprocess.run(
        ["codesign", "-d", "--entitlements", "-", "--xml", str(executable)],
        capture_output=True,
    ).stdout
    try:
        ent = plistlib.loads(
            subprocess.run(["plutil", "-convert", "xml1", "-o", "-", "-"],
                           input=ent_xml, capture_output=True, check=True).stdout
        )
    except Exception:
        raise SystemExit("could not read the signed entitlements; inspect the signature by hand")
    if ent.get("aps-environment") != "production":
        problems.append(f"signed aps-environment {ent.get('aps-environment')!r}")
    if ent.get("get-task-allow") is not False:
        problems.append(f"signed get-task-allow {ent.get('get-task-allow')!r}")

    digest = hashlib.sha256(ipa.read_bytes()).hexdigest()
    print(f"    {info['CFBundleIdentifier']} {marketing} ({build_number})")
    print(f"    aps-environment={ent.get('aps-environment')} "
          f"get-task-allow={ent.get('get-task-allow')}")
    print(f"    sha256 {digest}")
    if problems:
        raise SystemExit("the exported artifact is not what was asked for: " + "; ".join(problems))
    return digest


def submit(release_dir: Path, ipa: Path, env: dict, asc_app_id: str) -> None:
    """Upload the exact artifact. `--path`, never `--latest`: `--latest` means the newest EAS
    CLOUD build, which is not this one and may be an entirely different commit."""
    print("== submit")
    eas_json = APP / "eas.json"
    original = eas_json.read_text()
    try:
        cfg = json.loads(original)
        cfg.setdefault("submit", {})["production"] = {"ios": {"ascAppId": asc_app_id}}
        eas_json.write_text(json.dumps(cfg, indent=2) + "\n")
        run(["eas", "submit", "-p", "ios", "--profile", "production",
             "--path", str(ipa), "--non-interactive", "--wait"],
            cwd=APP, env=env, log=release_dir / "submit.log")
    finally:
        # Repo policy keeps ascAppId out of the committed file; restore the exact original rather
        # than re-serialising, so a pre-existing edit of somebody else's survives.
        eas_json.write_text(original)
    print(f"    submitted; log: {release_dir / 'submit.log'}")


# --------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--submit", action="store_true", help="upload the IPA after verifying it")
    ap.add_argument("--build-number", type=int,
                    help="override; the default is the EAS remote counter plus one")
    ap.add_argument("--skip-gates", action="store_true", help="skip npm test and typecheck")
    args = ap.parse_args()

    asc_app_id = os.environ.get("ASC_APP_ID", "").strip()
    if args.submit and not asc_app_id:
        raise SystemExit(
            "--submit needs ASC_APP_ID (the App Store Connect numeric app id). It is an Apple "
            "identifier and is deliberately not in this repository; export it, or find it in a "
            "previous submission on expo.dev."
        )

    env = eas_env()
    marketing = json.load(open(APP / "app.json"))["expo"]["version"]

    if not args.skip_gates:
        gates()

    build_number = args.build_number or next_build_number(env)
    release_dir = Path(os.environ.get("RELEASE_DIR")
                       or tempfile.mkdtemp(prefix="claudepost-release-"))
    release_dir = release_dir / f"{marketing}-{build_number}"
    release_dir.mkdir(parents=True, exist_ok=True)
    private = release_dir / "private"
    private.mkdir(exist_ok=True)
    private.chmod(0o700)

    print(f"== {marketing} ({build_number}) -> {release_dir}")
    print(f"    source {run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture=True)}")

    keychain = Keychain(private)
    try:
        creds = fetch_credentials(private)
        profile = read_profile(creds["profile"])
        team = profile["Entitlements"]["com.apple.developer.team-identifier"]
        env["EXPO_APPLE_TEAM_ID"] = team
        install_profile(creds["profile"], profile["UUID"])
        quarantine_stale_capability_cache(release_dir, team)

        prebuild(marketing, build_number)
        keychain.open(creds["p12"], creds["p12_password"].read_text())
        ipa = archive_and_export(release_dir, keychain, profile)
        digest = verify(release_dir, ipa, marketing, build_number)

        if args.submit:
            submit(release_dir, ipa, env, asc_app_id)
    finally:
        keychain.close()
        for name in ("dist.p12", "dist.pw", "profile.mobileprovision"):
            (private / name).unlink(missing_ok=True)

    print()
    print(f"IPA      {ipa}")
    print(f"sha256   {digest}")
    if args.submit:
        print("uploaded to App Store Connect; Apple's processing is a separate, later outcome —")
        print("check TestFlight before telling anyone the build is available.")
    print()
    print(f"Reserve the build number so a later cloud build cannot collide with it. It needs a "
          f"terminal:\n    cd app && eas build:version:set -p ios --profile production   # {build_number}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
