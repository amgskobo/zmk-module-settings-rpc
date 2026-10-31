# Activity report sender work budget

Run `python3 tests/report-sender/run.py` in the resolved west workspace with
Zephyr 4.1 and `native_sim/native/64`. `ZEPHYR_BASE` and `NANOPB_SOURCE` may select
preflighted checkouts. Set `SETTINGS_REPORT_ARTIFACTS` to a fresh directory to
retain configuration, ELF, executable, build output and raw per-run logs.

The complete production handler uses real Zephyr work, message queues and
semaphores with generated nanopb. Activity, event and Studio boundaries are
controlled.

The fixture disables CMake's west module discovery with `WEST=OFF` and an empty
`ZEPHYR_MODULES`; nanopb and owner sources are supplied explicitly. An empty
module list alone still discovers unrelated workspace Kconfig files, which can
prevent this standalone kernel fixture from configuring.

One binary runs each scenario three times:

- `full`: retain the first four reports, drop two excess reports and encode
  exact source/idle/sleep values in order.
- `refill`: add the next report during each send and retain ordered delivery.

In both cases a peer work item already queued behind the sender must run after
exactly one report. This checks the per-invocation work budget, including refill;
the host handler fixture alone cannot establish real workqueue scheduling.
Failed assertions, crashes and timeouts fail the command. The default artifact
directory is temporary; use the environment variable above to preserve evidence.

The queue capacity remains four and overflow drops the newest report. Each
invocation sends one report and resubmits at the queue tail if reports remain.
A single synchronous Studio send can still block the queue. These checks do
not establish physical USB/BLE/split delivery, send latency, cancellation or
compatibility with older Zephyr native backends. Keep the host role/wire checks
and board builds alongside this focused kernel check.
