#!/usr/bin/env python3
"""Test the complete RPC handler with real nanopb messages and stubbed ZMK APIs."""

import argparse
import contextlib
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def artifact_context(output, root, artifacts_root=None):
    if output is None:
        return tempfile.TemporaryDirectory(prefix="settings-rpc-")
    output = Path(output)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise ValueError("artifacts require a fresh absolute directory")
    output = output.resolve()
    if output.is_relative_to(root.resolve()):
        raise ValueError("artifacts must be outside the source checkout")
    if artifacts_root is not None and not output.is_relative_to(
        Path(artifacts_root).resolve()
    ):
        raise ValueError("artifacts must remain within the mounted results root")
    output.mkdir(parents=True, exist_ok=False)
    return contextlib.nullcontext(str(output))


class CommandRecorder:
    def __init__(self, work):
        self.work = work
        self.records = []

    def save(self):
        (self.work / "commands.json").write_text(
            json.dumps(self.records, indent=2) + "\n"
        )

    def run(self, command, *, timeout, env=None):
        record = dict(
            command=command,
            cwd=str(Path.cwd()),
            started_ns=time.time_ns(),
            status="running",
            sanitizer_options=(env or os.environ).get("ASAN_OPTIONS"),
        )
        self.records.append(record)
        self.save()
        started = time.monotonic_ns()
        log_path = self.work / f"command-{len(self.records):02d}.log"
        try:
            with log_path.open("wb") as log:
                result = subprocess.run(
                    command,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=timeout,
                    env=env,
                )
            record.update(status="complete", exit=result.returncode)
        except BaseException as error:
            record.update(status="incomplete", error=type(error).__name__)
            raise
        finally:
            record["elapsed_ns"] = time.monotonic_ns() - started
            self.save()
            print(log_path.read_text(errors="replace"), end="", flush=True)
        result.check_returncode()


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=root / "src/studio/settings_rpc_handler.c",
        help="override the handler source for regression reproduction",
    )
    parser.add_argument(
        "--artifacts",
        type=Path,
        default=os.environ.get("ACTIVITY_TEST_ARTIFACTS"),
        help="retain binaries, generated inputs, command records and raw logs in a fresh directory",
    )
    args = parser.parse_args()

    if "NANOPB_SOURCE" in os.environ:
        nanopb = Path(os.environ["NANOPB_SOURCE"]).resolve()
    else:
        nanopb = Path(
            subprocess.check_output(
                ["west", "list", "nanopb", "-f", "{abspath}"], cwd=root, text=True
            ).strip()
        )
    for name in (
        "pb_common.c",
        "pb_encode.c",
        "pb_decode.c",
        "generator/nanopb_generator.py",
    ):
        if not (nanopb / name).is_file():
            parser.error(f"missing nanopb dependency: {nanopb / name}")
    source = args.source.resolve()
    if not source.is_file():
        parser.error(f"missing handler source: {source}")

    try:
        context = artifact_context(
            args.artifacts, root, os.environ.get("ACTIVITY_TEST_ARTIFACTS_ROOT")
        )
    except ValueError as error:
        parser.error(str(error))

    with context as directory:
        work = Path(directory)
        run = CommandRecorder(work).run

        # The generator may regenerate its own Python proto. Keep dependency
        # checkouts read-only and avoid relying on pre-existing generated files.
        shutil.copytree(nanopb / "generator", work / "generator")
        run(
            [
                sys.executable,
                str(work / "generator/nanopb_generator.py"),
                "-I",
                str(root / "proto"),
                "-D",
                str(work),
                str(root / "proto/zmk/settings/core.proto"),
            ],
            timeout=60,
        )
        for name in (
            "zephyr/kernel.h",
            "zephyr/logging/log.h",
            "zmk/activity.h",
            "zmk/event_manager.h",
            "zmk/split/central.h",
            "zmk/studio/core.h",
            "zmk/studio/custom.h",
            "zmk/workqueue.h",
        ):
            header = work / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text("/* ZMK interfaces supplied by the host harness. */\n")

        variants = {
            "optimized": ["-O2"],
            "sanitized": [
                "-O1",
                "-g",
                "-fno-omit-frame-pointer",
                "-fsanitize=address,undefined",
                "-fno-sanitize-recover=all",
            ],
        }
        for role, split, central, relay, studio, sleep in (
            ("standalone", 0, 0, 0, 1, 1),
            ("central", 1, 1, 1, 1, 1),
            ("central-no-relay", 1, 1, 0, 1, 1),
            ("central-no-sleep", 1, 1, 1, 1, 0),
            ("peripheral", 1, 0, 1, 0, 1),
            ("peripheral-no-relay", 1, 0, 0, 0, 1),
        ):
            for label, flags in variants.items():
                binary = work / f"activity-{role}-{label}"
                run(
                    [
                        *shlex.split(os.environ.get("CC", "cc")),
                        "-std=c11",
                        "-Wall",
                        "-Wextra",
                        "-Werror",
                        "-Wno-unused-parameter",
                        "-Wno-unused-function",
                        *flags,
                        "-DPB_WITHOUT_64BIT=1",
                        f"-DCONFIG_ZMK_SPLIT={split}",
                        f"-DCONFIG_ZMK_SPLIT_RELAY_EVENT={relay}",
                        f"-DCONFIG_ZMK_SPLIT_ROLE_CENTRAL={central}",
                        f"-DCONFIG_ZMK_SLEEP={sleep}",
                        f"-DTEST_RPC={studio}",
                        f'-DTEST_ROLE="{role}"',
                        f'-DCHANGED_SOURCE="{root / "src/events/activity_settings_changed.c"}"',
                        f'-DREPORT_SOURCE="{root / "src/events/activity_settings_report.c"}"',
                        f'-DRPC_SOURCE="{source}"',
                        f'-DTEST_VARIANT="{label}"',
                        f"-I{nanopb}",
                        f"-I{work}",
                        f"-I{root / 'include'}",
                        str(root / "tests/activity/handler_test.c"),
                        str(work / "zmk/settings/core.pb.c"),
                        *(
                            str(nanopb / f"pb_{name}.c")
                            for name in ("common", "encode", "decode")
                        ),
                        "-o",
                        str(binary),
                    ],
                    timeout=60,
                )
                (work / f"{binary.name}.sha256").write_text(
                    hashlib.sha256(binary.read_bytes()).hexdigest() + "\n"
                )
                for repeat in range(1, 4):
                    print(f"activity {role}/{label} repeat={repeat}", flush=True)
                    run(
                        [str(binary)],
                        timeout=20,
                        env={**os.environ, "ASAN_OPTIONS": "detect_leaks=0"},
                    )


if __name__ == "__main__":
    main()
