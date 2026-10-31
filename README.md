# ZMK Module: Settings RPC with Custom Web UI

This repository contains a ZMK module for managing keyboard settings via a web interface using an **unofficial** custom Studio RPC protocol. It provides remote control of activity settings (sleep/idle timeouts) for both standalone and split keyboards.

Basic usage is similar to the official template. Read through the
[ZMK Module Creation](https://zmk.dev/docs/development/module-creation) page for
details on how to configure ZMK modules.

## Features

- **Activity Settings Management**: Control sleep and idle timeouts via web interface
- **Split Keyboard Support**: Synchronized settings across central and peripheral halves
- **Custom Studio RPC Protocol**: Protobuf-based communication for settings management
- **React Web UI**: Modern web interface for device configuration
- **Real-time Notifications**: Receive settings updates from all connected devices

The timeouts can be read while Studio is locked, but changing them needs an
unlocked Studio; a locked keyboard answers "Unlock required". The keyboard also
refuses a sleep timeout from 1 to 59999 ms ("Sleep too short"), because a
battery-powered keyboard would sleep again seconds after each key press; 0
still turns sleep off. A build without sleep support refuses any change of the
sleep timeout ("Sleep not supported"). A request refused by these validation guards changes nothing. A setter or
storage failure is a separate boundary: the core schedules persistence and the
RPC acknowledgement does not establish durable storage or atomic application
of both values on every device.

### Core Implementation

This module includes the following components:

- Core settings protocol: `proto/zmk/settings/core.proto` and `core.options`
- Settings RPC handler: `src/studio/settings_rpc_handler.c`
- Event relay system: `src/events/` (for split keyboard synchronization)
- Configuration flags in `Kconfig`
- Test suite: `./tests/studio`

The build selects the activity settings handler and schema explicitly. The
unused sample protocol has been removed; it had no registered handler or client.
An independent RPC extension must own its schema, handler and registration.

### Web UI

The `./web` directory contains a React-based web interface based on the
[vite template `react-ts`](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts)
(generated via `npm create vite@latest web -- --template react-ts`) and the React hook library
[@cormoran/react-zmk-studio](https://github.com/cormoran/react-zmk-studio).

For more details, refer to the
[react-zmk-studio README](https://github.com/cormoran/react-zmk-studio/blob/main/README.md).

## Setup

You can use this ZMK module with the following setup:

1. Add this module as a dependency to your `config/west.yml`.

   ```yaml
   # config/west.yml
   manifest:
     remotes:
       ...
       - name: amgskobo
         url-base: https://github.com/amgskobo
       - name: cormoran
         url-base: https://github.com/cormoran
     projects:
       ...
       - name: zmk-module-settings-rpc
         remote: amgskobo
         revision: codex/settings-rpc-review
       ...
       # The below settings are required to use the unofficial Studio custom RPC feature
       - name: zmk
         remote: cormoran
         revision: e5c9b6915b56801193e359dd9bad4a167ce0d1b8
         import:
           file: app/west.yml
   ```

2. Enable the feature flags in your `config/<shield>.conf`:

   ```conf
   # Enable ZMK Studio
   CONFIG_ZMK_STUDIO=y

   # Enable settings RPC module
   CONFIG_ZMK_SETTINGS_RPC=y
   CONFIG_ZMK_SETTINGS_RPC_STUDIO=y
   ```

3. The selected core supplies the compiled idle and sleep defaults through
   `CONFIG_ZMK_IDLE_TIMEOUT` and `CONFIG_ZMK_IDLE_SLEEP_TIMEOUT`. This module does
   not define an activity devicetree node. Stored core activity settings may
   override those defaults. The Web UI reads the effective reported values.

The fork branch above contains this implementation; it does not deploy a Web UI.
Use its prepared local Web build to exercise the reviewed client. The existing
upstream PR for getter presence remains separate from this fork review branch.

## Development Guide

### Setup

Run dependency setup, builds and test runtimes inside Docker. Host entry points
may launch containers and export results. There are two isolated west workspace
layout options; use a fresh workspace rather than replacing shared `.west` data.

#### Option 1: Download Dependencies in Parent Directory

This is West's standard approach. Choose this option if you want to reuse dependent projects in other Zephyr module development.

```bash
mkdir west-workspace
cd west-workspace # This directory becomes the West workspace root (topdir)
git clone --branch codex/settings-rpc-review https://github.com/amgskobo/zmk-module-settings-rpc.git
west init -l zmk-module-settings-rpc/west --mf west-test.yml
west update --narrow
west zephyr-export
```

The directory structure becomes like below:

```
west-workspace
  - .west/config
  - build : build output directory
  - <this repository>
  # other dependencies
  - zmk
  - zephyr
  - ...
  # You can develop other zephyr modules in this workspace
  - your-other-repo
```

Use another fresh workspace when selecting a different owner; keep existing
workspace metadata and prepared dependency revisions intact.

#### Option 2: Download Dependencies in ./dependencies (Enabled in Dev Container)

Choose this option if you want to download dependencies under this directory (similar to `node_modules` in npm). This option is useful for specifying cache targets in CI. The layout is easier to manage if you want to isolate dependencies.

```bash
git clone --branch codex/settings-rpc-review https://github.com/amgskobo/zmk-module-settings-rpc.git
cd <cloned directory>
west init -l west --mf west-test-standalone.yml
# If you use the dev container, start from the commands below.
# The above commands are executed automatically.
west update --narrow
west zephyr-export
```

The directory structure becomes like below:

```
<this repository>
  - .west/config
  - build : build output directory
  - dependencies
    - zmk
    - zephyr
    - ...
```

### Dev Container

The dev container is configured for setup option 2. The container creates the following volumes to reuse resources among containers:

- `zmk-dependencies`: Dependencies directory for setup option 2
- `zmk-build`: Build output directory
- `zmk-root-user`: /root, same as ZMK's official dev container

### Web UI

Please refer [./web/README.md](./web/README.md).

## Testing

**ZMK Firmware Tests**

The host protocol check compiles the complete production RPC handler with the
real generated nanopb schema and the production event listeners, using
controlled ZMK activity/event/framework interfaces. It verifies encoded getter
presence and values (including both
timeouts disabled and uint32 limits), GetAll notifications, valid writes,
setter failures and malformed/unsupported requests. It also verifies applying
relayed settings, ignoring self-originated changes and reporting peripheral
settings. Standalone, split-central (with/without relay and with sleep disabled) and
peripheral variants run optimized and under ASan/UBSan: ten variants in total. It does not test Studio transport,
radio delivery, real event scheduling or timeout validation policy.

```bash
# After west update, with Python, protobuf/protoc and a C compiler available:
python3 tests/activity/run.py
# Outside a west workspace, select an existing nanopb checkout:
NANOPB_SOURCE=/path/to/nanopb python3 tests/activity/run.py
```

`bash tests/run-host-docker.sh` dispatches that same owner check directly when
already inside a prepared Docker workspace, without nesting Docker. From a host
shell, explicitly select a preflighted named dependency volume and nanopb path:

```bash
export ZMK_DOCKER_CACHE_VOLUME='<prepared-dependency-volume>'
export ZMK_NANOPB_RELATIVE_PATH=modules/lib/nanopb
# Optional: override the pinned CI SDK image with another reviewed digest.
export ZMK_TEST_IMAGE='<prepared-image>@sha256:<digest>'
bash tests/run-host-docker.sh
```

The host entry mounts owner and dependency inputs read-only, disables the
network, and defaults to two CPUs and 4 GiB. `ZMK_TEST_CPUS` and
`ZMK_TEST_MEMORY` select the shared test budget. Prepare the selected image's
compiler/Python/protobuf environment and verify nanopb's exact revision before
the run. The entry performs no dependency installation or fetch. Registration
fixtures retain both native_posix_64 and native_sim filenames; the selected DYA
matrix uses native_sim, while stock ZMK remains NOT APPLICABLE.

The `./tests` directory contains test configurations for POSIX to verify module functionality and configurations for the Xiao board to confirm builds work correctly.

Activity report notifications send one report per low-priority work invocation
and resubmit at the queue tail. The four-report queue retains its drop-newest
policy. For changes to this work budget, also run the
[real-kernel sender check](tests/report-sender/README.md) with the resolved
Zephyr 4.1 workspace: `python3 tests/report-sender/run.py`. A synchronous
transport call can still stall that queue; the check does not prove radio or
split delivery.

Tests can be executed with the following command:

```bash
# Run all test cases and verify results
python -m unittest discover -s tests -p test_owner.py
```

If you want to execute West commands manually, use the following (note: for zmk-build, results are not verified):

```bash
# Build test firmware for Xiao
# `-m tests/zmk-config .` means tests/zmk-config and this repo are added as additional Zephyr modules
west zmk-build tests/zmk-config/config -m tests/zmk-config .

# Run ZMK test cases
# -m . is required to add this module to the build
west zmk-test tests -m .
```

**Web UI Tests**

The Web scripts dispatch canonical Jest fixtures from `tests/web/`. See the
[Web development guide](./web/README.md#development) for schema generation and
test/build commands.

```bash
bash tests/run-web.sh
```

## Publishing Web UI

### GitHub Pages (Production)

GitHub Actions are pre-configured to publish the web UI to GitHub Pages.

1. Visit Settings > Pages
2. Set source as "GitHub Actions"
3. Visit Actions > "Test and Build Web UI"
4. Click "Run workflow"

The Web UI will be available at
`https://<your GitHub account>.github.io/<repository name>/`, for example: https://cormoran.github.io/zmk-module-settings-rpc.

### Cloudflare Workers (Pull Request Preview)

For previewing web UI changes in pull requests:

1. Create a Cloudflare Workers project and configure the following secrets:

   - `CLOUDFLARE_API_TOKEN`: API token with Cloudflare Pages edit permission
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
   - (Optional) `CLOUDFLARE_PROJECT_NAME`: Project name (defaults to `zmk-module-web-ui`)
   - Enable the "Preview URLs" feature in the Cloudflare project

2. Optionally, set up an `approval-required` environment in GitHub repository settings requiring approval from repository owners

3. Create a pull request with web UI changes - the preview deployment will trigger automatically and wait for approval

## Sync Changes from Template

By running `Actions > Sync Changes in Template > Run workflow`, a pull request is created to your repository to reflect changes from the template repository.

If the template contains changes in `.github/workflows/*`, you must register your GitHub personal access token as `GH_TOKEN` in the repository secrets.
The fine-grained token requires write permissions for contents, pull requests, and workflows.
For more details, see [actions-template-sync](https://github.com/AndreasAugustin/actions-template-sync).

## More Information

For more information on modules, you can read through the
[Zephyr modules page](https://docs.zephyrproject.org/3.5.0/develop/modules.html),
[ZMK's page on using modules](https://zmk.dev/docs/features/modules), and
[Zephyr's West manifest page](https://docs.zephyrproject.org/3.5.0/develop/west/manifest.html#west-manifests).
