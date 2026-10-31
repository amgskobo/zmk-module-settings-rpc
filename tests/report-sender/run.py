#!/usr/bin/env python3
"""Real Zephyr workqueue check with controlled Studio/event/activity boundaries."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--source", type=Path, default=root / "src/studio/settings_rpc_handler.c"
)
args = parser.parse_args()
zephyr = Path(
    os.environ.get("ZEPHYR_BASE")
    or subprocess.check_output(
        ["west", "list", "zephyr", "-f", "{abspath}"], text=True
    ).strip()
)
nanopb = Path(
    os.environ.get("NANOPB_SOURCE")
    or subprocess.check_output(
        ["west", "list", "nanopb", "-f", "{abspath}"], text=True
    ).strip()
)
with tempfile.TemporaryDirectory(prefix="settings-report-native-") as directory:
    work = Path(directory)
    generated = work / "generated"
    generated.mkdir()
    shutil.copytree(nanopb / "generator", work / "generator")
    subprocess.run(
        [
            "python3",
            str(work / "generator/nanopb_generator.py"),
            "-I",
            str(root / "proto"),
            "-D",
            str(generated),
            str(root / "proto/zmk/settings/core.proto"),
        ],
        check=True,
    )
    for rel in [
        "zephyr/logging/log.h",
        "zmk/activity.h",
        "zmk/event_manager.h",
        "zmk/split/central.h",
        "zmk/studio/core.h",
        "zmk/studio/custom.h",
        "zmk/workqueue.h",
    ]:
        path = generated / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("/* Controlled framework boundary; kernel remains real. */\n")
    out = Path(os.environ.get("SETTINGS_REPORT_ARTIFACTS", str(work / "results")))
    assert not out.exists(), "Use a fresh SETTINGS_REPORT_ARTIFACTS"
    out.mkdir(parents=True)
    command = [
        "west",
        "build",
        "-p=always",
        "-b",
        "native_sim/native/64",
        "-s",
        str(root / "tests/report-sender"),
        "-d",
        str(work / "build"),
        "--",
        "-DWEST=OFF",
        "-DZEPHYR_MODULES=",
        "-DZephyr_DIR=" + str(zephyr / "share/zephyr-package/cmake"),
        "-DGENERATED_ROOT=" + str(generated),
        "-DNANOPB_ROOT=" + str(nanopb),
        "-DOWNER_ROOT=" + str(root),
        "-DRPC_SOURCE=" + str(args.source.resolve()),
    ]
    with (out / "build.log").open("w") as log:
        result = subprocess.run(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=dict(os.environ, ZEPHYR_BASE=str(zephyr)),
        )
    if result.returncode:
        print((out / "build.log").read_text()[-6000:])
        raise SystemExit(2)
    for rel in [
        "zephyr/.config",
        "zephyr/zephyr.elf",
        "zephyr/zephyr.exe",
        "CMakeCache.txt",
    ]:
        shutil.copyfile(work / "build" / rel, out / Path(rel).name)
    records = []
    for scenario in ["full", "refill"]:
        for run in [1, 2, 3]:
            with (out / f"{scenario}-{run}.log").open("w") as log:
                result = subprocess.run(
                    ["timeout", "10", str(work / "build/zephyr/zephyr.exe")],
                    env=dict(os.environ, SETTINGS_REPORT_CASE=scenario),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            records.append(dict(scenario=scenario, run=run, exit=result.returncode))
            print((out / f"{scenario}-{run}.log").read_text(), flush=True)
    (out / "results.json").write_text(json.dumps(records, indent=2) + "\n")
    raise SystemExit(int(any(r["exit"] for r in records)))
