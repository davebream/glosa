#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

workspace="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"
glosa_home="${GLOSA_HOME:-$workspace/.context/glosa-home}"
lock="$glosa_home/daemon.lock"

if [[ ! -f "$lock" ]]; then
  exit 0
fi

pid="$(GLOSA_HOME="$glosa_home" bun -e 'console.log(JSON.parse(await Bun.file(`${process.env.GLOSA_HOME}/daemon.lock`).text()).pid)' 2>/dev/null || true)"

if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$lock"
  exit 0
fi

command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
if [[ "$command_line" != *"packages/cli/src/main.ts __daemon"* ]]; then
  rm -f "$lock"
  exit 0
fi

kill -TERM "$pid" 2>/dev/null || true
for _ in {1..50}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
  sleep 0.1
done

printf 'glosa daemon pid %s did not stop before archive\n' "$pid" >&2
exit 1
