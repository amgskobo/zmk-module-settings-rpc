#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

# A prepared container already owns the dependency selection. Do not nest Docker.
if [[ -f /.dockerenv ]]; then
  exec python3 "$root/tests/activity/run.py" "$@"
fi

: "${ZMK_DOCKER_CACHE_VOLUME:?Select a preflighted named dependency volume}"
: "${ZMK_NANOPB_RELATIVE_PATH:?Select nanopb relative to that volume root}"
image="${ZMK_TEST_IMAGE:-zmkfirmware/zmk-build-arm@sha256:edb1c953438c6f720ddb79c3762f3972013b7fbbaf4fff3592fc869983e7afc5}"
[[ $image =~ @sha256:[[:xdigit:]]{64}$ ]] || { echo 'Select an image pinned by sha256 digest' >&2; exit 2; }
[[ $ZMK_DOCKER_CACHE_VOLUME =~ ^[[:alnum:]][[:alnum:]_.-]*$ ]] || { echo 'Select a named volume, not a host directory' >&2; exit 2; }
case "/$ZMK_NANOPB_RELATIVE_PATH/" in
  *'/../'*|*'/./'*|*'//'*) echo 'Select a normalized relative nanopb path' >&2; exit 2 ;;
esac
[[ $ZMK_NANOPB_RELATIVE_PATH != /* ]] || { echo 'Select a relative nanopb path' >&2; exit 2; }

# Git Bash supplies cygpath; Windows Docker needs the native bind-source path.
mount_root="$root"
if command -v cygpath >/dev/null 2>&1; then mount_root="$(cygpath -am "$root")"; fi
export MSYS_NO_PATHCONV=1
# Ordinary runs must not pull an image or create a new dependency volume.
docker image inspect "$image" >/dev/null
docker volume inspect "$ZMK_DOCKER_CACHE_VOLUME" >/dev/null
docker run --rm --pull never --network none \
  --cpus "${ZMK_TEST_CPUS:-2}" --memory "${ZMK_TEST_MEMORY:-4g}" \
  --volume "$mount_root:/src:ro" \
  --volume "$ZMK_DOCKER_CACHE_VOLUME:/cache:ro" \
  --env "NANOPB_SOURCE=/cache/$ZMK_NANOPB_RELATIVE_PATH" \
  "$image" python3 /src/tests/activity/run.py "$@"
