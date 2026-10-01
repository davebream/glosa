# Manjaro installed-package qualification

Status: **held, no qualified Linux desktop release**. This is the reproducible procedure for #435,
not a passing compatibility certificate. Container and source-test results remain complementary.

## Current holds

| Prerequisite | State |
| --- | --- |
| Temporary x86_64 desktop | No spending authorized. Provisioning remains held. |
| Linux dictation implementation | #434 remains a prerequisite; verify its current evidence before scheduling. |
| Provider accounts | Maintainer will supply two distinct Claude and two distinct Codex subscriptions when scheduled. |
| Wispr live smoke | Needs one usable API credential, explicit paid-use consent and maintainer attendance. |
| Offering determination | G1 must be explicitly settled before the SDK qualification run. |
| Generic T8 | #19 is closed, but the 2026-09-30 report records failure and no signature. Require a passing signed successor or explicit maintainer reconciliation. |

The first branch CI attempt ([run 36838198869](https://github.com/davebream/glosa/actions/runs/36838198869))
is a failed diagnostic, not Linux qualification. Pacman smoke, macOS shell, unpartitioned full and
quality passed. Linux acceptance exposed a Darwin-only monitor lock, macOS-only Keychain CLI cases
and Linux shortcut handling in two image-paste tests. The implementation now selects the Linux
`flock` binding, carries the X display into shell subprocesses and uses the platform shortcut in
the browser fixture; those changes still need Linux CI confirmation. The six Keychain CLI cases
are named in `scripts/test-plan.ts` and remain covered by macOS CI, Linux daemon/SPA/provider
fixtures and the held installed-app dictation ceremony, not by a claimed Linux Keychain pass.
The run also failed the Linux shell because its test harness omitted `DISPLAY`; macOS browser
partitions had two real-engine timing failures. The security scan found a medium-severity `hono`
advisory in the existing lockfile. No candidate may be created from that run.

The follow-up [run 36840004632](https://github.com/davebream/glosa/actions/runs/36840004632)
passed Linux acceptance, pacman smoke, macOS shell and all three macOS partitions. Linux renderer
security executed 11 real-Electron cases; nine passed, while a macOS-only Dock assertion and a
`.dmg` update fixture failed. Their Linux equivalents are now under test. The same `hono` advisory
still failed the security job in that run; the pinned dependency has been moved to the reported
fixed version for the next run. These CI attempts are not installed Manjaro session evidence.

Do not reopen issues, sign evidence, provision infrastructure or publish a release merely because
this procedure exists. #435 stays open until its entire acceptance contract passes.

## Desktop feasibility

After a spending limit is authorized, create a temporary x86_64 Vultr machine, initially 4 vCPUs,
8 GB RAM and 80 GB disk, using the official Manjaro KDE ISO. Record the ISO checksum and installed
snapshot. Use Manjaro stable repositories, never replace them with Arch repositories. Vultr's
[custom ISO procedure](https://docs.vultr.com/how-to-upload-and-use-custom-isos-on-vultr) provides
installation through its browser console. These resources are planning defaults, not a purchase.

Before account login, demonstrate both Plasma Wayland and Plasma X11 in a real interactive
desktop. Record `echo "$XDG_SESSION_TYPE"`, `uname -a`, `getconf GNU_LIBC_VERSION`, `git --version`,
`plasmashell --version` and `/etc/os-release`. Prove usable Secret Service storage and actual live
microphone capture through the selected remote desktop connection. Record the transport and audio
device. A virtual prerecorded audio source proves only the simulated boundary. If Wayland, the
secure store or live microphone forwarding cannot be made usable, stop with that named hold.

Keep Glosa on loopback. Access the desktop through an authenticated console or tunnel. Do not
expose its API ports or disable Chromium's sandbox to make the remote environment work. Take a
clean snapshot before installing Glosa; keep an account-free snapshot for repeated installation
checks. Remove temporary infrastructure only after approved evidence retention and credential cleanup.

## Freeze and install

Download the retained candidate following [the release procedure](../release.md). Verify its
checksum before copying it to the desktop and after transfer. Record the candidate artifact/run
IDs, source commit, checksum and complete runtime tuple from `candidate.json`. Record actual
bundled Bun and Electron versions and the installed provider versions/lock hashes as observed.

Start with no checkout and no host Bun or Node: `command -v bun` and `command -v node` must find
nothing before package installation. Install only the candidate and its dependencies through
`sudo pacman -U ./glosa-<version>-x64.pacman`. Preserve the dependency-resolution output. Check
`pacman -Q glosa`, `glosa --version` and the recorded executable. Fixtures contain neutral synthetic
documents only. Keep raw logs, login URLs, credentials and account identities out of public reports.

## Run on both sessions

Every row generated by `qualification-template` needs an observation for both Wayland and X11.
Record commands, expected/actual behavior and evidence references, including failures.

| Area | Required observations |
| --- | --- |
| Desktop integration | Launch from menu with the correct icon; choose a folder; reveal it in Dolphin; receive a notification. Invoke a real `glosa://` link with `kde-open` when closed, observe its confirmation, then invoke it while open. |
| Document loop | CLI/MCP startup, pairing, annotation delivery/acknowledgement, review approval, edit/save and history restore. Compare saved bytes and journal/provenance against the intended changes. Observe external changes and reconnect without losing feedback. |
| Security | Inspect renderer command lines and `/proc/<renderer-pid>/status` for sandbox/seccomp evidence. Exercise unauthorized Host/Origin requests, token pairing/revocation, path escape refusal and the existing class-F inert egress probe. |
| Lifecycle | Close/reopen the window, kill only the recorded owned daemon and recover, and verify child cleanup with receipts plus independent process inspection. Upgrade between retained versioned packages, uninstall and reinstall while preserving workspace, journal and history bytes. Verify old resources cannot mix with new ones. |
| Dictation | Store/read/delete a disposable secret through the real desktop service; test locked, absent, denied and cancelled access. Allow, deny and cancel microphone use. After consent, insert a live-provider draft into all four composers without submitting it; verify cancellation ends capture/transport. |

## Native G1–G4 and final approval

Use the complete [Linux native qualification handoff](../design/2026-09-23-agent-chat-implementation.md#linux-native-qualification-handoff-433-to-435).
Its standalone driver uses the installed sources and bundled Bun without a public gate override.
Resolve offering permission before SDK use. For each provider use genuinely different A/B accounts,
verify ordinary configuration and credential metadata before/after, observe real refresh and expiry,
relogin, model/effort, permission decisions, questions, resume and MCP OAuth. Exercise terminal resize,
login cancellation, tool cancellation and process-tree crash cleanup while an unrelated sentinel lives.

An unobserved expiry is held. A source-driver result is not an installed UI pass. Keep managed
execution unqualified until its existing joint gate and offering requirements are satisfied.
Any approved qualification/activation change creates new package bytes: assemble a new candidate
and rerun installed-app G4, the desktop matrix and the expanded T8 ceremony on that candidate.
Existing macOS qualification is unchanged. Only the maintainer signs the passing T8 report.

The signed JSON record binds every result to the exact candidate, including both desktop sessions.
Publish only sanitized reproducible observations. After maintainer approval and release initiation,
verify downloaded GitHub assets against the retained checksum. Reconcile #430's children and every
#435 acceptance criterion before closing #435. A partial implementation PR uses a reference without
a closing keyword. This procedure does not close or replace generic T8 acceptance.
