"""Use real synthetic ELF programs to check native-result admission."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from native_verifier import verify_native


class NativeVerifierContract(unittest.TestCase):
    def setUp(self):
        retained = os.environ.get("OWNER_NATIVE_CONTROL_OUTPUT")
        if retained:
            base = Path(retained)
            owner = Path(__file__).resolve().parents[1]
            if not base.is_absolute() or base.resolve().is_relative_to(owner):
                raise ValueError(
                    "retained controls require absolute evidence outside source"
                )
            self.root = base.resolve() / self._testMethodName
            self.root.mkdir(parents=True, exist_ok=False)
        else:
            self.temp = tempfile.TemporaryDirectory()
            self.addCleanup(self.temp.cleanup)
            self.root = Path(self.temp.name)
        self.tests = self.root / "fixtures"
        fixture = self.tests / "case"
        fixture.mkdir(parents=True)
        (fixture / "native_sim.keymap").write_text(
            "/* Synthetic native fixture marker. */\n"
        )
        (fixture / "native_sim.conf").write_text("CONFIG_OWNER_TEST=y\n")
        (fixture / "events.patterns").write_text("/^EVENT /p\n")
        (fixture / "keycode_events.snapshot").write_text("EVENT 1\n")
        (self.tests / "required_hooks.json").write_text(
            json.dumps([{"configs": ["CONFIG_OWNER_TEST"], "hook": "control"}])
        )
        self.output = self.root / "build"
        binary_dir = self.output / "case" / "zephyr"
        binary_dir.mkdir(parents=True)
        (binary_dir / ".config").write_text("CONFIG_OWNER_TEST=y\n")
        self.binary = binary_dir / "zmk.exe"

    def compile(
        self,
        *,
        hook=True,
        reported=0,
        process_exit=0,
        fatal=False,
        failed_log=False,
        benign_sanitizer_names=False,
    ):
        source = self.root / "program.c"
        body = "#include <stdio.h>\n"
        if hook:
            body += (
                "int owner_checked_control(void) { "
                f'puts("OWNER_TEST_RESULT control={reported}"); return 0; }}\n'
            )
        body += "int main(void) { "
        if hook:
            body += "owner_checked_control(); "
        if fatal:
            body += 'puts("ASSERTION FAIL"); '
        if failed_log:
            body += 'puts("<err> owner: FAIL: controlled assertion"); '
        if benign_sanitizer_names:
            body += (
                'puts("CONFIG_ASAN=y AddressSanitizer enabled"); '
                'puts("UndefinedBehaviorSanitizer setting; runtime error counter=0"); '
            )
        body += f'puts("EVENT 1"); return {process_exit}; }}\n'
        source.write_text(body)
        command = [
            "cc",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-MD",
            "-MF",
            str(self.root / "program.d"),
            str(source),
            "-o",
            str(self.binary),
        ]
        started = time.time_ns()
        result = subprocess.run(command, capture_output=True, text=True)
        (self.root / "compile.log").write_text(result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (self.root / "compile.json").write_text(
            json.dumps(
                {
                    "argv": command,
                    "cwd": str(Path.cwd()),
                    "start_unix_ns": started,
                    "exit": result.returncode,
                    "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "binary_sha256": hashlib.sha256(
                        self.binary.read_bytes()
                    ).hexdigest(),
                },
                indent=2,
            )
            + "\n"
        )

    def compile_recovering_sanitizer(self, sanitizer):
        """A real diagnostic with successful init/snapshot and process exit zero."""
        source = self.root / "sanitizer.c"
        fault = (
            "volatile int index = 4; unsigned char *data = malloc(4); "
            "if (!data) return 2; data[index] = 7; free(data);"
            if sanitizer == "address"
            else "volatile int value = INT_MAX; value += 1; (void)value;"
        )
        source.write_text(
            "#include <limits.h>\n#include <stdio.h>\n#include <stdlib.h>\n"
            "int owner_checked_control(void) { "
            'puts("OWNER_TEST_RESULT control=0"); return 0; }\n'
            "int main(void) { "
            + fault
            + ' owner_checked_control(); puts("EVENT 1"); return 0; }\n'
        )
        command = [
            "cc",
            "-std=c11",
            "-O0",
            "-g",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fno-pie",
            "-no-pie",
            "-fno-omit-frame-pointer",
            "-fsanitize=" + sanitizer,
            "-fsanitize-recover=all",
            "-MD",
            "-MF",
            str(self.root / "sanitizer.d"),
            str(source),
            "-o",
            str(self.binary),
        ]
        started = time.time_ns()
        result = subprocess.run(command, capture_output=True, text=True)
        (self.root / "compile.log").write_text(result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (self.root / "compile.json").write_text(
            json.dumps(
                {
                    "argv": command,
                    "cwd": str(Path.cwd()),
                    "start_unix_ns": started,
                    "exit": result.returncode,
                    "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "binary_sha256": hashlib.sha256(
                        self.binary.read_bytes()
                    ).hexdigest(),
                },
                indent=2,
            )
            + "\n"
        )
        env = dict(
            os.environ,
            ASAN_OPTIONS="detect_leaks=0:halt_on_error=0",
            UBSAN_OPTIONS="halt_on_error=0:print_stacktrace=1",
        )
        diagnostic = "AddressSanitizer:" if sanitizer == "address" else "runtime error:"
        runs = self.root / "direct-runs"
        runs.mkdir()
        for trial in range(1, 4):
            output = runs / str(trial)
            output.mkdir()
            clock = time.monotonic_ns()
            result = subprocess.run(
                [str(self.binary)],
                cwd=output,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=30,
            )
            (output / "raw.log").write_text(result.stdout)
            (output / "command.json").write_text(
                json.dumps(
                    {
                        "argv": [str(self.binary)],
                        "cwd": str(output),
                        "elapsed_ns": time.monotonic_ns() - clock,
                        "exit": result.returncode,
                        "environment": {
                            key: env[key] for key in ("ASAN_OPTIONS", "UBSAN_OPTIONS")
                        },
                    },
                    indent=2,
                )
                + "\n"
            )
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn(diagnostic, result.stdout)
            self.assertIn("OWNER_TEST_RESULT control=0", result.stdout)
            self.assertIn("EVENT 1\n", result.stdout)
        return env

    def test_recovering_asan_with_zero_exit_is_rejected(self):
        env = self.compile_recovering_sanitizer("address")
        with (
            patch.dict(os.environ, env),
            self.assertRaisesRegex(AssertionError, "sanitizer diagnostic"),
        ):
            verify_native(self.output, self.tests)

    def test_recovering_ubsan_with_zero_exit_is_rejected(self):
        env = self.compile_recovering_sanitizer("undefined")
        with (
            patch.dict(os.environ, env),
            self.assertRaisesRegex(AssertionError, "sanitizer diagnostic"),
        ):
            verify_native(self.output, self.tests)

    def test_sanitizer_names_and_normal_markers_are_not_diagnostics(self):
        self.compile(benign_sanitizer_names=True)
        verify_native(self.output, self.tests)

    def test_positive_repeats_preserve_raw_output(self):
        self.compile()
        verify_native(self.output, self.tests)
        runs = self.binary.parent.parent / "verified-runs"
        self.assertEqual(
            sorted(path.name for path in runs.iterdir() if path.is_dir()),
            ["1", "2", "3"],
        )
        for trial in range(1, 4):
            self.assertEqual(
                (runs / str(trial) / "events.log").read_text(), "EVENT 1\n"
            )
            self.assertIn(
                "OWNER_TEST_RESULT control=0",
                (runs / str(trial) / "raw.log").read_text(),
            )

    def test_missing_checked_init_is_not_snapshot_success(self):
        self.compile(hook=False)
        with self.assertRaisesRegex(AssertionError, "missing checked init"):
            verify_native(self.output, self.tests)

    def test_failed_init_is_not_snapshot_success(self):
        self.compile(reported=-22)
        with self.assertRaisesRegex(AssertionError, "completion"):
            verify_native(self.output, self.tests)

    def test_real_process_exit_is_required(self):
        self.compile(process_exit=7)
        with self.assertRaisesRegex(AssertionError, "native exit 7"):
            verify_native(self.output, self.tests)

    def test_requested_test_cannot_be_disabled_in_build(self):
        self.compile()
        (self.binary.parent / ".config").write_text("# CONFIG_OWNER_TEST is not set\n")
        with self.assertRaisesRegex(AssertionError, "required configuration"):
            verify_native(self.output, self.tests)

    def test_logged_assertion_cannot_pass_with_zero_init_result(self):
        self.compile(failed_log=True)
        with self.assertRaisesRegex(AssertionError, "failed owner assertion"):
            verify_native(self.output, self.tests)

    def test_fixture_requires_its_test_even_when_both_configs_omit_it(self):
        self.compile()
        (self.tests / "required_hooks.json").write_text(
            json.dumps(
                [
                    {
                        "fixtures": ["case"],
                        "configs": ["CONFIG_OWNER_TEST"],
                        "hook": "control",
                    }
                ]
            )
        )
        (self.tests / "case/native_sim.conf").write_text("")
        (self.binary.parent / ".config").write_text("")
        with self.assertRaisesRegex(AssertionError, "required configuration"):
            verify_native(self.output, self.tests)

    def test_fixture_role_cannot_be_replaced_by_a_wrong_built_role(self):
        self.compile()
        (self.tests / "required_hooks.json").write_text(
            json.dumps(
                [
                    {
                        "fixtures": ["case"],
                        "configs": ["CONFIG_OWNER_TEST"],
                        "not_configs": ["CONFIG_ROLE_CENTRAL"],
                        "hook": "control",
                    }
                ]
            )
        )
        (self.binary.parent / ".config").write_text(
            "CONFIG_OWNER_TEST=y\nCONFIG_ROLE_CENTRAL=y\n"
        )
        with self.assertRaisesRegex(AssertionError, "required configuration"):
            verify_native(self.output, self.tests)

    def test_unrelated_fixture_declaration_does_not_require_a_hook(self):
        self.compile(hook=False)
        (self.tests / "required_hooks.json").write_text(
            json.dumps(
                [
                    {
                        "fixtures": ["other"],
                        "configs": ["CONFIG_OWNER_TEST"],
                        "hook": "control",
                    }
                ]
            )
        )
        verify_native(self.output, self.tests)

    def test_missing_native_fixture_cannot_be_a_partial_success(self):
        self.compile()
        other = self.tests / "missing-case"
        other.mkdir()
        (other / "native_sim.keymap").write_text("/* A required second scenario. */\n")
        with self.assertRaisesRegex(AssertionError, "missing native fixtures"):
            verify_native(self.output, self.tests)

    def test_fatal_with_zero_exit_is_rejected(self):
        self.compile(fatal=True)
        with self.assertRaisesRegex(AssertionError, "fatal assertion"):
            verify_native(self.output, self.tests)


if __name__ == "__main__":
    unittest.main(verbosity=2)
