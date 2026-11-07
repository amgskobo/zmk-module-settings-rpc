# SPDX-License-Identifier: MIT
"""Require the pinned SDK console-site audit to reject one new executable site."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
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
    source = owner / "web/node_modules/@zmkfirmware/zmk-studio-ts-client/lib/index.js"
    original = source.read_bytes()
    (output / "original-sdk-index.js").write_bytes(original)
    faulty = (
        original
        + (
            "\nfunction syntheticUnreviewedSdkLogSite() {\n"
            '  console.info("SYNTHETIC_UNREVIEWED_SDK_SITE", "synthetic-value");\n}\n'
        ).encode()
    )
    (output / "fault-sdk-index.js").write_bytes(faulty)
    command = [
        "bash",
        "tests/run-web.sh",
        "--json",
        "--outputFile",
        str(output / "jest.json"),
    ]
    started = time.time_ns()
    source.write_bytes(faulty)
    try:
        with (output / "raw.log").open("wb") as log:
            process = subprocess.run(
                command, cwd=owner, stdout=log, stderr=subprocess.STDOUT
            )
    finally:
        source.write_bytes(original)
    assert source.read_bytes() == original
    data = json.loads((output / "jest.json").read_text())
    failed = [
        assertion
        for suite in data["testResults"]
        for assertion in suite["assertionResults"]
        if assertion["status"] == "failed"
    ]
    expected = "finds only reviewed console calls in the pinned Studio SDK"
    qualified = (
        process.returncode == 1
        and data["numTotalTests"] == 69
        and data["numFailedTests"] == 1
        and data["numPassedTests"] == 68
        and data["numPendingTests"] == 0
        and len(failed) == 1
        and failed[0]["fullName"] == expected
        and "SYNTHETIC_UNREVIEWED_SDK_SITE" in "\n".join(failed[0]["failureMessages"])
    )
    report = {
        "argv": command,
        "cwd": str(owner),
        "start_unix_ns": started,
        "end_unix_ns": time.time_ns(),
        "exit": process.returncode,
        "expected_assertion": expected,
        "total": data["numTotalTests"],
        "pass": data["numPassedTests"],
        "failed": data["numFailedTests"],
        "pending": data["numPendingTests"],
        "original_sdk_sha256": hashlib.sha256(original).hexdigest(),
        "fault_sdk_sha256": hashlib.sha256(faulty).hexdigest(),
        "restored": True,
        "status": "QUALIFIED EXPECTED REJECTION" if qualified else "FAIL",
    }
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if qualified else 1


if __name__ == "__main__":
    raise SystemExit(main())
