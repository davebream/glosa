#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

workspace="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"
port="${CONDUCTOR_PORT:-4646}"

export GLOSA_HOME="${GLOSA_HOME:-$workspace/.context/glosa-home}"
export GLOSA_PORT="${GLOSA_PORT:-$port}"
export GLOSA_CLASSF_PORT="${GLOSA_CLASSF_PORT:-$((GLOSA_PORT + 1))}"

mkdir -p "$GLOSA_HOME"

url="$(bun packages/cli/src/main.ts open --url "$workspace")"
printf '%s\n' "$url"
printf 'glosa daemon log: %s\n' "$GLOSA_HOME/daemon.log"

if [[ "${CONDUCTOR_OPEN_BROWSER:-1}" != "0" ]] && command -v open >/dev/null 2>&1; then
  open "$url"
fi

pid="$(bun -e 'console.log(JSON.parse(await Bun.file(`${process.env.GLOSA_HOME}/daemon.lock`).text()).pid)')"

cleanup() {
  trap - HUP INT TERM EXIT
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.1
    done
  fi
}

trap cleanup HUP INT TERM EXIT

while kill -0 "$pid" 2>/dev/null; do
  sleep 1
done
