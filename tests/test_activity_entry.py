"""Exercise activity evidence and the real launcher with controlled processes."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "activity_entry", ROOT / "tests/activity/run.py"
)
ENTRY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENTRY)


class ActivityEntryContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_fresh_output_retains_real_binary_and_failed_process_log(self):
        output = self.root / "results"
        with ENTRY.artifact_context(output, ROOT) as directory:
            work = Path(directory)
            source = work / "control.c"
            source.write_text(
                '#include <stdio.h>\nint main(void) { puts("CONTROL EXIT"); return 7; }\n'
            )
            binary = work / "control"
            recorder = ENTRY.CommandRecorder(work)
            recorder.run(["cc", str(source), "-o", str(binary)], timeout=10)
            before = binary.read_bytes()
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                recorder.run([str(binary)], timeout=5)
            self.assertEqual(caught.exception.returncode, 7)
            invalid_source = work / "invalid.c"
            invalid_source.write_text("#error CONTROL_COMPILE_FAILURE\n")
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                recorder.run(
                    ["cc", str(invalid_source), "-o", str(work / "invalid")],
                    timeout=10,
                )
            self.assertNotEqual(caught.exception.returncode, 0)
        self.assertEqual(binary.read_bytes(), before)
        self.assertEqual((work / "command-02.log").read_text(), "CONTROL EXIT\n")
        records = json.loads((work / "commands.json").read_text())
        self.assertEqual([record["exit"] for record in records[:2]], [0, 7])
        self.assertEqual(records[2]["exit"], caught.exception.returncode)
        self.assertIn("CONTROL_COMPILE_FAILURE", (work / "command-03.log").read_text())
        self.assertTrue(all(record["elapsed_ns"] > 0 for record in records))

    def test_existing_relative_and_checkout_outputs_are_refused(self):
        file = self.root / "file"
        file.write_text("PRESERVE")
        directory = self.root / "directory"
        directory.mkdir()
        link = self.root / "link"
        link.symlink_to(self.root / "missing")
        for path in (file, directory, link, Path("relative"), ROOT / "must-not-create"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                ENTRY.artifact_context(path, ROOT)
        self.assertEqual(file.read_text(), "PRESERVE")
        self.assertTrue(link.is_symlink())
        self.assertFalse((ROOT / "must-not-create").exists())
        mount = self.root / "mounted-results"
        mount.mkdir()
        (mount / "escape").symlink_to(directory, target_is_directory=True)
        for path in (directory / "outside", mount / "escape/outside"):
            with (
                self.subTest(path=path),
                self.assertRaisesRegex(ValueError, "mounted results root"),
            ):
                ENTRY.artifact_context(path, ROOT, mount)
        with ENTRY.artifact_context(mount / "nested/fresh", ROOT, mount) as retained:
            self.assertTrue(Path(retained).is_relative_to(mount))
            self.assertTrue(Path(retained).is_dir())

    def test_default_preserves_temporary_cleanup(self):
        with ENTRY.artifact_context(None, ROOT) as directory:
            path = Path(directory)
            self.assertTrue(path.is_dir())
        self.assertFalse(path.exists())

    def test_command_is_recorded_before_launch_with_ordered_output(self):
        recorder = ENTRY.CommandRecorder(self.root)
        script = (
            "import json, os, pathlib; "
            f"record = json.loads(pathlib.Path({str(self.root / 'commands.json')!r}).read_text())[-1]; "
            "assert record['status'] == 'running' and 'exit' not in record; "
            "os.write(1, b'FIRST\\n'); os.write(2, b'SECOND\\n')"
        )
        recorder.run([sys.executable, "-c", script], timeout=5)
        self.assertEqual(
            (self.root / "command-01.log").read_bytes(), b"FIRST\nSECOND\n"
        )

    def test_launch_and_timeout_errors_have_no_fabricated_exit(self):
        recorder = ENTRY.CommandRecorder(self.root)
        for argv, timeout, error in (
            ([str(self.root / "missing-command")], 5, FileNotFoundError),
            (
                [
                    sys.executable,
                    "-c",
                    "import time; print('BEFORE TIMEOUT', flush=True); time.sleep(5)",
                ],
                0.2,
                subprocess.TimeoutExpired,
            ),
        ):
            with self.subTest(argv=argv), self.assertRaises(error):
                recorder.run(argv, timeout=timeout)
        records = json.loads((self.root / "commands.json").read_text())
        self.assertEqual(
            [record["status"] for record in records], ["incomplete", "incomplete"]
        )
        self.assertTrue(all("exit" not in record for record in records))
        self.assertEqual((self.root / "command-02.log").read_text(), "BEFORE TIMEOUT\n")

    def host(self, updates=None, args=()):
        bin_dir = self.root / "bin"
        bin_dir.mkdir(exist_ok=True)
        docker = bin_dir / "docker"
        docker.write_text(
            "#!/usr/bin/python3\nimport json, os, sys\n"
            "with open(os.environ['CONTROL_DOCKER_LOG'], 'a') as log: log.write(json.dumps(sys.argv[1:])+'\\n')\n"
            "sys.exit(1 if os.environ.get('CONTROL_DOCKER_FAIL') == ' '.join(sys.argv[1:]) else 0)\n"
        )
        docker.chmod(0o755)
        log = self.root / "docker.jsonl"
        if log.exists():
            log.unlink()
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("ZMK_TEST_")
        }
        environment.update(
            PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
            CONTROL_DOCKER_LOG=str(log),
            ZMK_DOCKER_CACHE_VOLUME="synthetic-dependencies",
            ZMK_NANOPB_RELATIVE_PATH="modules/lib/nanopb",
        )
        environment.update(updates or {})
        result = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; shift; run_host "$@"',
                "control",
                str(ROOT / "tests/run-host-docker.sh"),
                *args,
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        calls = (
            [json.loads(line) for line in log.read_text().splitlines()]
            if log.exists()
            else []
        )
        return result, calls

    def test_host_dispatch_preserves_default_and_selected_result_mounts(self):
        result, calls = self.host(args=("--source", "/src/control.c"))
        self.assertEqual(result.returncode, 0, result.stdout)
        command = calls[-1]
        self.assertEqual(
            command[:6], ["run", "--rm", "--pull", "never", "--network", "none"]
        )
        self.assertIn("synthetic-dependencies:/cache:ro", command)
        self.assertNotIn("/results", " ".join(command))
        self.assertEqual(command[-2:], ["--source", "/src/control.c"])
        result, calls = self.host(
            {
                "ZMK_TEST_RESULTS_VOLUME": "synthetic-results",
                "ZMK_TEST_ARTIFACTS_RELATIVE_PATH": "review/activity",
            }
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(["volume", "inspect", "synthetic-results"], calls)
        self.assertIn("synthetic-results:/results", calls[-1])
        self.assertIn("ACTIVITY_TEST_ARTIFACTS=/results/review/activity", calls[-1])
        self.assertIn("ACTIVITY_TEST_ARTIFACTS_ROOT=/results", calls[-1])

    def test_host_cli_output_options_cannot_override_retained_mount(self):
        for updates in (
            {},
            {
                "ZMK_TEST_RESULTS_VOLUME": "synthetic-results",
                "ZMK_TEST_ARTIFACTS_RELATIVE_PATH": "review/activity",
            },
        ):
            for args in (
                ("--artifacts", "/tmp/disposable"),
                ("--artifacts=/tmp/disposable",),
                ("--art=/tmp/disposable",),
                ("--a", "/tmp/disposable"),
            ):
                with self.subTest(updates=updates, args=args):
                    result, calls = self.host(updates, args)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Host output selection uses", result.stdout)
                    self.assertEqual(calls, [])

    def test_prepared_container_dispatch_forwards_cli_and_environment(self):
        self.assertTrue(Path("/.dockerenv").is_file(), "Run owner checks in Docker")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        python = bin_dir / "python3"
        log = self.root / "prepared.json"
        python.write_text(
            "#!/usr/bin/python3\nimport json, os, pathlib, sys\n"
            f"pathlib.Path({str(log)!r}).write_text(json.dumps(dict(argv=sys.argv[1:], artifacts=os.environ.get('ACTIVITY_TEST_ARTIFACTS'))))\n"
        )
        python.chmod(0o755)
        result = subprocess.run(
            [
                "bash",
                str(ROOT / "tests/run-host-docker.sh"),
                "--artifacts",
                "/results/cli",
            ],
            env=dict(
                os.environ,
                PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                ACTIVITY_TEST_ARTIFACTS="/results/environment",
            ),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(
            json.loads(log.read_text()),
            dict(
                argv=[
                    str(ROOT / "tests/activity/run.py"),
                    "--artifacts",
                    "/results/cli",
                ],
                artifacts="/results/environment",
            ),
        )

    def test_invalid_host_results_or_failed_preflight_never_launch_docker(self):
        for updates in (
            {"ZMK_TEST_RESULTS_VOLUME": "synthetic-results"},
            {"ZMK_TEST_ARTIFACTS_RELATIVE_PATH": "review"},
            {
                "ZMK_TEST_RESULTS_VOLUME": "/host/path",
                "ZMK_TEST_ARTIFACTS_RELATIVE_PATH": "review",
            },
            *(
                {
                    "ZMK_TEST_RESULTS_VOLUME": "synthetic-results",
                    "ZMK_TEST_ARTIFACTS_RELATIVE_PATH": path,
                }
                for path in ("/absolute", "../escape", "a/./b", "a//b")
            ),
            {"CONTROL_DOCKER_FAIL": "volume inspect synthetic-dependencies"},
        ):
            with self.subTest(updates=updates):
                result, calls = self.host(updates)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] == "run" for call in calls))


if __name__ == "__main__":
    unittest.main(verbosity=2)
