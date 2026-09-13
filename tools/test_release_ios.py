"""Release command logging and temporary-keychain cleanup, without macOS mutations."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_ios", Path(__file__).with_name("release-ios.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseKeychainTest(unittest.TestCase):
    def test_secret_flags_are_redacted_but_subprocess_receives_original(self):
        password = "sample-password-never-log"
        for args in (
            ["security", "create-keychain", "-p", password, "/tmp/public.keychain"],
            ["security", "unlock-keychain", "-p", password, "/tmp/public.keychain"],
            ["security", "import", "-P", password, "-k", "/tmp/public.keychain"],
            ["security", "set-key-partition-list", "-k", password, "/tmp/public.keychain"],
        ):
            with self.subTest(command=args[1]), patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess(args, 0, "")) as command:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    release.run(args)
                self.assertNotIn(password, output.getvalue())
                self.assertIn("/tmp/public.keychain", output.getvalue())
                self.assertEqual(command.call_args.args[0], args)

    def test_failure_diagnostics_do_not_echo_secret(self):
        password = "sample-password-never-log"
        args = ["security", "unlock-keychain", "-p", password, "/tmp/public.keychain"]
        output = io.StringIO()
        with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess(args, 1, "rejected " + password)):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), self.assertRaises(SystemExit) as error:
                release.run(args, capture=True)
        self.assertNotIn(password, output.getvalue() + str(error.exception))

    def test_nonsecret_security_flags_keep_their_values(self):
        args = ["security", "find-identity", "-p", "codesigning", "/tmp/public.keychain"]
        output = io.StringIO()
        with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess(args, 0, "")), contextlib.redirect_stdout(output):
            release.run(args)
        self.assertIn("-p codesigning /tmp/public.keychain", output.getvalue())

    def open_keychain(self, original):
        keychain = release.Keychain(Path("/tmp/release-test"))
        with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, original)), contextlib.redirect_stdout(io.StringIO()):
            keychain.open(Path("/tmp/public.p12"), "sample-p12-password")
        return keychain

    def test_restores_exact_original_list_including_empty_list(self):
        for original, paths in (( '"/tmp/first.keychain"\n"/tmp/second keychain"', ["/tmp/first.keychain", "/tmp/second keychain"]), ("", [])):
            keychain = self.open_keychain(original)
            with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "")) as command, contextlib.redirect_stdout(io.StringIO()):
                keychain.close()
            self.assertEqual([call.args[0] for call in command.call_args_list], [
                ["security", "list-keychains", "-d", "user", "-s", *paths],
                ["security", "delete-keychain", str(keychain.path)],
            ])

    def test_restoration_failure_is_reported_and_deletion_still_attempted(self):
        keychain = self.open_keychain('"/tmp/first.keychain"')
        with patch.object(release.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 1, "failed"), subprocess.CompletedProcess([], 0, "")]) as command:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                keychain.close()
        self.assertEqual(command.call_args_list[-1].args[0], ["security", "delete-keychain", str(keychain.path)])

    def test_deletion_failure_is_reported(self):
        keychain = self.open_keychain("")
        with patch.object(release.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 1, "failed")]):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                keychain.close()

    def test_close_before_open_does_not_mutate_keychains(self):
        keychain = release.Keychain(Path("/tmp/release-test"))
        with patch.object(release.subprocess, "run") as command:
            keychain.close()
        command.assert_not_called()

    def test_private_files_are_removed_even_when_keychain_cleanup_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            def fail_after_writing_credentials(private):
                for name in ("dist.p12", "dist.pw", "profile.mobileprovision"):
                    (private / name).write_text("sample-secret")
                raise RuntimeError("build interrupted")
            with patch.object(release.sys, "argv", ["release-ios.py", "--build-number", "42", "--skip-gates"]), patch.dict(release.os.environ, {"RELEASE_DIR": directory}), patch.object(release, "run", return_value="test-source"), patch.object(release, "fetch_credentials", side_effect=fail_after_writing_credentials), patch.object(release.Keychain, "close", side_effect=SystemExit("cleanup failed")), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main()
            self.assertEqual(list(Path(directory).rglob("dist.*")), [])
            self.assertEqual(list(Path(directory).rglob("*.mobileprovision")), [])


if __name__ == "__main__":
    unittest.main()
