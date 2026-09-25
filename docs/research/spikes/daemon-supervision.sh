#!/bin/bash
# Supervision spike (issue #361 item 2): a detached child versus a launchd user agent, measured
# against the ownership spec's R-O3 (spawn only when absent, keep the pid) and R-O4 (the daemon
# outlives the shell). Uses its own GLOSA_HOME and ports; touches nothing under ~/Library.
# Run: SPIKE_DIR=<scratch dir> bash daemon-supervision.sh
set -u
S=${SPIKE_DIR:?set SPIKE_DIR to a scratch directory}
BUN=$(which bun)
MAIN=$(readlink -f "$(which glosa)")           # the install's entry point, e.g. .../packages/cli/src/main.ts
hs() { local r; r=$(curl -s -m 2 "http://127.0.0.1:$1/api/handshake" | jq -r '.instance_id' 2>/dev/null); echo "${r:-none}"; }
lockpid() { jq -r .pid "$GLOSA_HOME/daemon.lock" 2>/dev/null; }

echo "== detached child =="
export GLOSA_HOME=$S/home-detached GLOSA_PORT=47020; rm -rf "$GLOSA_HOME"; mkdir -p "$GLOSA_HOME"
echo "1. before spawn: $(hs 47020)"
# R-O3: the shell's spawn on 'no answer' — the same argv the CLI uses, stdio detached, pid kept.
nohup "$BUN" "$MAIN" __daemon </dev/null >/dev/null 2>&1 & PID=$!; disown
for i in $(seq 1 40); do id=$(hs 47020); [ "$id" != none ] && break; sleep 0.25; done
echo "   spawned pid=$PID, handshake ${id} after ~$((i/4))s, lock pid $(lockpid) (same: $([ "$(lockpid)" = "$PID" ] && echo yes || echo no))"
echo "2. R-O4: the spawning shell is gone (this script is not its parent any more); alive=$(kill -0 "$PID" 2>/dev/null && echo yes || echo no)"
glosa open "$S/fixture-ws" --url >/dev/null 2>&1
echo "3. R-O3: a later client reuses it, no second spawn: $(hs 47020) (same instance: $([ "$(hs 47020)" = "$id" ] && echo yes || echo no))"
echo "4. stop-guard input (GET /api/status): sessions=$(glosa status --json | jq '[.data.sessions[]?]|length') workspaces=$(glosa status --json | jq '[.data.workspaces[]?]|length')"
kill -TERM "$PID"; for i in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
echo "5. SIGTERM: $(kill -0 "$PID" 2>/dev/null && echo 'still alive' || echo "exited in ~$((i/4))s"); log: $(tail -1 "$GLOSA_HOME/daemon.log")"

echo; echo "== launchd user agent =="
export GLOSA_HOME=$S/home-launchd GLOSA_PORT=47030; rm -rf "$GLOSA_HOME"; mkdir -p "$GLOSA_HOME"
LABEL=dev.glosa.spike.daemon; PLIST=$S/$LABEL.plist
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$MAIN</string><string>__daemon</string></array>
  <key>EnvironmentVariables</key><dict><key>GLOSA_HOME</key><string>$GLOSA_HOME</string><key>GLOSA_PORT</key><string>47030</string><key>PATH</key><string>$(dirname "$BUN"):/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>2</integer>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 40); do id=$(hs 47030); [ "$id" != none ] && break; sleep 0.25; done
LPID=$(launchctl print "gui/$(id -u)/$LABEL" | awk '/^\tpid = /{print $3}')
echo "1. bootstrap: handshake $id after ~$((i/4))s, launchd pid $LPID, lock pid $(lockpid)"
sleep 4; echo "2. stays up with no client for 4s: $(hs 47030)"
kill -TERM "$LPID"
for i in $(seq 1 40); do nid=$(hs 47030); [ "$nid" != none ] && [ "$nid" != "$id" ] && break; sleep 0.25; done
echo "3. after SIGTERM launchd respawns it: $nid after ~$((i/4))s"
launchctl bootout "gui/$(id -u)/$LABEL"; sleep 1
glosa open "$S/fixture-ws" --url >/dev/null 2>&1; cid=$(hs 47030)
echo "4. bootout, then a CLI client spawns its own: $cid (lock pid $(lockpid))"
launchctl bootstrap "gui/$(id -u)" "$PLIST"; sleep 7
echo "   re-bootstrap with KeepAlive beside the CLI's daemon, 7s later: handshake $(hs 47030) (still the CLI's: $([ "$(hs 47030)" = "$cid" ] && echo yes || echo no)); launchd attempts that lost the lock: $(grep -c 'benign race' "$GLOSA_HOME/daemon.log")"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1; LP=$(lockpid); [ -n "$LP" ] && kill -TERM "$LP" 2>/dev/null; sleep 2
echo "   teardown: handshake $(hs 47030); job present: $(launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo yes || echo no)"
