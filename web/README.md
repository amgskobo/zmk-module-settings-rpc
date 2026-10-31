# Activity settings client

This React client connects to a keyboard through Studio's USB serial transport.
It reads and updates idle and sleep timeouts through the `zmk__settings` custom
RPC subsystem. The keyboard must support that unofficial Studio extension.
The firmware registers this subsystem as unsecured so the timeouts can be read
while Studio is locked, but it refuses a change unless Studio is unlocked
("Unlock required"). The transport's own requirements still apply.

`src/App.tsx` owns connection controls. `src/ActivitySettings.tsx` collects
settings from the central and reporting peripherals, displays differences,
and offers refresh, save and synchronization. A successful setter response
does not prove delivery to every peripheral; refresh and incoming notifications
provide the reported values.

Connection, subsystem-index and discovered-catalog changes reset this view. Responses and notifications
from an earlier connection are ignored, and request deadlines and refresh timers are canceled on replacement or
unmount. A successful or failed request releases its five-second deadline. A synchronization acknowledgement keeps any reported
peripheral mismatch visible until refreshed notifications establish new values.
It confirms that the request was applied locally, not delivery to every device.

Unsolicited reports keep the device list and mismatch warning current while
preserving unsaved input, including invalid text. An explicit Refresh replaces
the draft with newly reported values. A successful save or synchronization
acknowledges the submitted draft; it does not confirm delivery to every device.
Retiring a client stops its UI work and follow-up requests. An RPC already
handed to the transport may still take effect; retirement provides no rollback.

Timeout edits remain text until save or synchronization. Both actions accept
whole decimal milliseconds from 0 through 4294967295; 0 disables that timeout.
Empty fields, negative/fractional values, exponent notation and out-of-range
values are rejected before encoding or sending an RPC. They are not truncated
or silently converted to zero. The firmware further refuses a sleep timeout
from 1 to 59999 ms and, in a build without sleep support, any change of the
sleep timeout; the client shows the firmware's error message. Notifications
retain the firmware's exact unsigned values, including the upper bound.

## Development

Use Node.js and the checked-in npm lockfile inside a prepared Docker workspace.
Keep installed dependencies and generated outputs in a container or named volume:

```sh
npm ci
npm run dev
npm test
npm run lint
npm run build
```

The development, test and build commands generate TypeScript messages from
`../proto` with `buf generate`. Generated files under `src/proto` are ignored;
a fresh checkout does not need a previous build before testing. Watch and
coverage modes use the same generation step:

```sh
npm run test:watch
npm run test:coverage
```

The generator settings are in `buf.gen.yaml`. The activity wire schema is
`../proto/zmk/settings/core.proto`; `zmk__settings` must match the firmware's
registration. Do not change a wire field or subsystem identifier independently
of the firmware.

## Verification limits

Jest renders the controls and exercises RPC responses and notifications through
controlled connection helpers. These tests do not establish USB or Bluetooth
delivery, Studio access control, real split scheduling or persistence on a
board. The module's separate activity-handler suite uses generated nanopb and
the complete production C handler for its wire contracts; see the root README.

`npm run build` writes local output. Publishing requires a separate explicit
instruction; running these commands does not upload the client.

## Console privacy

Console failures include a fixed operation label and an allowlisted error category.
Messages, stacks, causes, arbitrary error names, profile/device names, addresses,
setting keys, prefixes, and values are not console arguments. UI errors and
intentional setting/profile displays retain their existing behavior. Individual RPC payloads and notifications are not console diagnostics.
The Vite plugin also sanitizes executable console output in the two locked Studio SDKs. New SDK log sites stop the build for review; both SDKs are excluded from development prebundling so the same transform applies in development and production. Browser-generated diagnostics and unrelated browser extensions are outside this application's control.

## Dependency security

`package.json` overrides the Studio client's transitive `protobufjs` dependency
to `7.6.5`, including the patched UTF-8 helper. Use `npm ci` with this lockfile.
After changing dependencies, run `npm audit --omit=dev`, the Web tests and the
production build.
