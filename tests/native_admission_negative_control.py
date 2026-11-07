# SPDX-License-Identifier: MIT
"""Qualify the original admission hole using this owner's live ELF controls."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import types
import unittest

import test_native_verifier

ORIGINAL_COMMIT = "8a1702c00fa6fb601d4ba58cb3667dd96e98ff51"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fixed-probe", action="store_true")
    args = parser.parse_args()
    owner = Path(__file__).resolve().parents[1]
    output = args.output
    if (
        not output.is_absolute()
        or output.exists()
        or output.is_symlink()
        or output.resolve().is_relative_to(owner)
    ):
        parser.error("select fresh absolute evidence outside the owner checkout")
    output = output.resolve()
    output.mkdir(parents=True)
    command = [
        "git",
        "-c",
        "safe.directory=" + str(owner),
        "-C",
        str(owner),
        "show",
        ORIGINAL_COMMIT + ":tests/native_verifier.py",
    ]
    original_source = subprocess.check_output(command)
    (output / "original-native-verifier.py").write_bytes(original_source)
    original = types.ModuleType("original_owner_native_verifier")
    exec(
        compile(original_source, str(output / "original-native-verifier.py"), "exec"),
        original.__dict__,
    )
    test_native_verifier.verify_native = original.verify_native
    os.environ["OWNER_NATIVE_CONTROL_OUTPUT"] = str(output / "cases")
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(
            test_native_verifier.NativeVerifierContract
        )
    )
    expected = {
        "test_recovering_asan_with_zero_exit_is_rejected",
        "test_recovering_ubsan_with_zero_exit_is_rejected",
    }
    failures = {test._testMethodName for test, _ in result.failures}
    valid = (
        result.testsRun == 14
        and failures == expected
        and not result.errors
        and not result.skipped
        and all("AssertionError not raised" in trace for _, trace in result.failures)
    )
    report = {
        "run": result.testsRun,
        "failures": [test.id() for test, _ in result.failures],
        "errors": [test.id() for test, _ in result.errors],
        "skipped": [test.id() for test, _ in result.skipped],
        "original_source_sha256": hashlib.sha256(original_source).hexdigest(),
        "source_command": command,
        "status": "QUALIFIED EXPECTED REJECTIONS" if valid else "FAIL",
    }
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    if not valid:
        return 1
    if args.fixed_probe:
        spec = importlib.util.spec_from_file_location(
            "fixed_owner_native_verifier", owner / "tests/native_verifier.py"
        )
        fixed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixed)
        probes = []
        for name in sorted(expected):
            case = output / "cases" / name
            retained = case / "build/case/zephyr/zmk.exe"
            stage = output / "fixed-same-elf" / name
            binary_dir = stage / "case/zephyr"
            binary_dir.mkdir(parents=True)
            shutil.copy2(retained, binary_dir / "zmk.exe")
            shutil.copy2(retained.parent / ".config", binary_dir / ".config")
            before = hashlib.sha256(retained.read_bytes()).hexdigest()
            old_env = dict(os.environ)
            os.environ.update(
                ASAN_OPTIONS="detect_leaks=0:halt_on_error=0",
                UBSAN_OPTIONS="halt_on_error=0:print_stacktrace=1",
            )
            try:
                with unittest.TestCase().assertRaisesRegex(
                    AssertionError, "sanitizer diagnostic"
                ):
                    fixed.verify_native(stage, case / "fixtures")
            finally:
                os.environ.clear()
                os.environ.update(old_env)
            raw = (stage / "case/verified-runs/1/raw.log").read_text()
            actual = json.loads(
                (stage / "case/verified-runs/1/command.json").read_text()
            )
            assert actual["exit"] == 0
            assert "AddressSanitizer:" in raw or "runtime error:" in raw
            assert (
                hashlib.sha256((binary_dir / "zmk.exe").read_bytes()).hexdigest()
                == before
            )
            probes.append(
                {
                    "case": name,
                    "binary_sha256": before,
                    "process_exit": 0,
                    "fixed_rejection": "sanitizer diagnostic",
                }
            )
        (output / "fixed-same-elf-probes.json").write_text(
            json.dumps(probes, indent=2) + "\n"
        )
    print(
        "Original native verifier rejected by both specified live assertions; other12 pass"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
