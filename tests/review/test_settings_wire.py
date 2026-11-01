"""Encode/decode the production GetActivitySettings result with real nanopb.

Container entry: NANOPB_ROOT=/resolved/nanopb python3 -m unittest discover
    -s tests/review -p test_settings_wire.py -v

The activity getters are fixed stand-ins. The actual handler body, schema,
options, generated C descriptors and nanopb codec are used unchanged.
"""

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src/studio/settings_rpc_handler.c"


def handler_body(text):
    for match in re.finditer(r"^static int handle_get_activity_settings\(", text, re.M):
        closing = text.index(")", match.end())
        if not text[closing + 1 :].lstrip().startswith("{"):
            continue
        opening = text.index("{", closing)
        depth = 0
        for token in re.finditer(
            r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|[{}]', text[opening:], re.S
        ):
            if token.group() == "{":
                depth += 1
            elif token.group() == "}":
                depth -= 1
                if depth == 0:
                    line = text.count("\n", 0, match.start()) + 1
                    return (
                        f'#line {line} "{SOURCE}"\n'
                        + text[match.start() : opening + token.end()]
                    )
    raise ValueError("GetActivitySettings definition not found")


PREFIX = r"""
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include "core.pb.h"
#define LOG_DBG(...) ((void)0)
static uint32_t zmk_activity_get_idle_ms(void) { return 1000; }
static uint32_t zmk_activity_get_sleep_ms(void) { return 60000; }
"""

SCENARIO = r"""
#line 1 "review-wire-scenario.c"
int main(int argc, char **argv) {
    assert(argc == 2);
    setbuf(stdout, NULL);
    zmk_settings_GetActivitySettingsRequest request = zmk_settings_GetActivitySettingsRequest_init_zero;
    zmk_settings_Response response = zmk_settings_Response_init_zero;
    assert(handle_get_activity_settings(&request, &response) == 0);
    if (strcmp(argv[1], "codec-control") == 0) {
        response.response_type.get_activity_settings.has_settings = true;
    } else { assert(strcmp(argv[1], "production") == 0); }
    uint8_t bytes[64];
    pb_ostream_t output = pb_ostream_from_buffer(bytes, sizeof(bytes));
    assert(pb_encode(&output, zmk_settings_Response_fields, &response));
    zmk_settings_Response decoded = zmk_settings_Response_init_zero;
    pb_istream_t input = pb_istream_from_buffer(bytes, output.bytes_written);
    assert(pb_decode(&input, zmk_settings_Response_fields, &decoded));
    assert(decoded.which_response_type == zmk_settings_Response_get_activity_settings_tag);
    zmk_settings_GetActivitySettingsResponse *result = &decoded.response_type.get_activity_settings;
    printf("wire bytes=%zu, has_settings=%d, idle=%u, sleep=%u\n",
           output.bytes_written, result->has_settings, result->settings.idle_ms, result->settings.sleep_ms);
    assert(result->has_settings);
    assert(result->settings.idle_ms == 1000 && result->settings.sleep_ms == 60000);
    return 0;
}
"""


class SettingsWireReview(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dependency = Path(os.environ["NANOPB_ROOT"])
        cls.temp = tempfile.TemporaryDirectory(prefix="settings-wire-review-")
        cls.addClassCleanup(cls.temp.cleanup)
        work = Path(cls.temp.name)
        # The generator may compile its own Python descriptor module. Keep that
        # build output in a private copy; never write to the selected dependency.
        nanopb = work / "nanopb"
        shutil.copytree(
            dependency, nanopb, ignore=shutil.ignore_patterns(".git", "__pycache__")
        )
        generated = work / "generated"
        generated.mkdir()
        subprocess.run(
            [
                "python3",
                str(nanopb / "generator/nanopb_generator.py"),
                "-D",
                str(generated),
                "-I",
                str(ROOT / "proto"),
                str(ROOT / "proto/zmk/settings/core.proto"),
            ],
            check=True,
        )
        (header,) = generated.rglob("core.pb.h")
        (descriptor,) = generated.rglob("core.pb.c")
        source = SOURCE.read_text()
        unit = work / "review.c"
        unit.write_text(PREFIX + handler_body(source) + SCENARIO)
        print(
            "Handler source SHA256:",
            hashlib.sha256(source.encode()).hexdigest(),
            flush=True,
        )
        cls.binary = work / "wire"
        subprocess.run(
            [
                "cc",
                "-std=c11",
                "-Wall",
                "-Wextra",
                "-Wno-unused-parameter",
                "-O2",
                "-DPB_WITHOUT_64BIT=1",
                "-I" + str(nanopb),
                "-I" + str(generated),
                "-I" + str(header.parent),
                str(unit),
                str(descriptor),
                str(nanopb / "pb_common.c"),
                str(nanopb / "pb_encode.c"),
                str(nanopb / "pb_decode.c"),
                "-o",
                str(cls.binary),
            ],
            check=True,
        )

    def run_case(self, name):
        result = subprocess.run(
            [str(self.binary), name],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        print(name + f": exit={result.returncode}\n" + result.stdout, flush=True)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_codec_control_preserves_settings(self):
        self.run_case("codec-control")

    def test_production_response_preserves_settings(self):
        self.run_case("production")


if __name__ == "__main__":
    unittest.main()
