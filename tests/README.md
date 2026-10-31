# Owner tests

This repository owns its executable test logic and fixtures under `tests/`.

## Current test ownership and compatibility

This owner supports DYA custom Studio RPC. Stock ZMK is NOT APPLICABLE;
no feature-disabled stock check is required or counted as compatibility.

Canonical entries (run from the repository root):

```bash
python3 -m unittest discover -v -s tests -p test_owner.py
bash tests/run-web.sh
```

[maintenance.json](maintenance.json) records supported cores, current commands
and explicit gaps. It is a reference map, not a passing test or a claim that
registration/coverage totals establish completeness. Preserve ordered outputs,
raw timestamps and the first failure. Read actual dependencies before execution.

`OWNER_TEST_OUTPUT=/absolute/new/directory` retains owner native/build outputs.
An existing directory fails before tests. Without it a fresh temporary directory
is printed and retained. No shared build directory is deleted. Use
`PYTHONPATH=tests python3 -m unittest -v test_owner.WestCommandsTests.<method>`
for a focused case; discovery runs the complete documented class.

Web assertions and Jest configuration live in `tests/web/`; application source
and installed dependencies remain in `web/`. The package scripts only dispatch
the owner configuration. No dependencies are installed implicitly by the tests.

The native verifier runs each built binary three times in independent empty
initial-flash directories, retaining raw output before filtering. It checks real
process exits, fatal assertions and every linked checked-init result before
comparing unchanged owner snapshots. A SYS_INIT error cannot be hidden by a
later matching key trace. Native scheduling and controlled APIs still do not
establish physical transport/retention. Test-only core/tool dependencies are
pinned; update pins only after reviewing the new sources and rerunning this
owner matrix. No network updates are implicit in the owner test command.

The 2026-10-14 fixture refresh replaces the retired `seeeduino_xiao_ble`
board alias with the selected DYA `xiao_ble//zmk` target. Both split roles
remain explicit in `split-config/build.yaml`; separate fresh output paths
keep role checks from reading an unrelated workspace build.

## Reproducible isolated checks

Use this owner's `west/west-test-standalone.yml` and its pinned test dependency
manifest. Test ZMK is `e5c9b6915b56801193e359dd9bad4a167ce0d1b8`;
Zephyr is `10ba6d0cb38bc3d258775d27982f707599320085`. Resolve the
manifest and verify actual checkout identities before running. Do not inherit
global CMake module overrides or moving production dependency references into
these isolated fixtures. The CI SDK image is pinned by digest in
`.github/workflows/zmk-module.yml`; production dependency manifests are separate.

Use a new `OWNER_TEST_OUTPUT` directory for every complete owner run. Native
repeats reuse one compiled binary with independent initial-flash state; keep
the first failure and raw combined stdout/stderr order. DYA-only compatibility
still means no stock-ZMK test requirement.

The owner command boundary limits `zmk-build` to one target at a time by
default. `OWNER_TEST_BUILD_PARALLELISM` selects an explicit positive target
count; account for compiler jobs and concurrent owners in the global budget.
`tests/test_build_budget.py` checks default/explicit forwarding and rejects
invalid budgets before launching west. The canonical owner entry includes
these controls without dropping any native or board scenario.

Native result admission requires every `native_sim.keymap` fixture to have a
matching binary. `required_hooks.json` names the expected checked initialization
hooks and required feature/role configuration. Fixture-bound declarations also
reject missing configuration when both the request and build omit it; excluded
roles cannot replace the requested role. The verifier retains all three raw
runs before comparing unchanged ordered snapshots and rejects logged failures,
fatal output and missing/nonzero completions. `tests/test_native_verifier.py`
owns eleven real-ELF admission controls, including a deliberately missing
native scenario, wrong-role and unrelated-fixture controls.

`bash tests/run-web.sh` is the canonical schema-generation/Web test entry.
It runs all configured Jest scenarios in one worker process. The pre-commit
Jest hook dispatches this same owner entry so nested workers do not multiply
the global container budget. Build and lint retain their separate package entries.

## Activity wire, sender and Web lifetime checks

`bash tests/run-host-docker.sh` dispatches `tests/activity/run.py` inside the
prepared container. Its ten optimized/ASan/UBSan variants retain standalone,
central with/without relay, central without sleep and peripheral boundaries.
The source includes missing-setting, locked, short-sleep and unsupported-sleep
refusals, exact getter presence, notifications, setter failure/recovery and
queue drop/recovery controls. A successful acknowledgement does not establish
durable storage or atomic multi-device application.

Run `python3 tests/report-sender/run.py` with a fresh
`SETTINGS_REPORT_ARTIFACTS` directory for the real-kernel queue contract. The
same binary runs the full/refill scenarios three times each. No synchronous
Studio-send latency or physical split-delivery bound is inferred.

`web/sessionLifecycle.spec.tsx` uses the production editor and generated codec
with a controlled RPC transport. Twenty-one cases cover connection/index/catalog
retirement, pending writes and delayed sync refreshes, request deadline cleanup,
unsaved/invalid draft preservation, explicit refresh, StrictMode and ordinary or
falsy transport rejection. The original editor fails thirteen cases; eight
positive controls retain its existing behavior. The previous Web assertions
remain unchanged; two fixtures now spy on the owner deadline client rather than
the SDK wrapper. The owner client uses the same custom call wire contract.

Run `bash tests/run-web.sh`, `npm --prefix web run lint` and
`npm --prefix web run build` in the prepared container. These are DOM/controlled
transport checks, not browser/device acceptance. Wire schema/options are unchanged.
