#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# glosa's pacman package ships every file it needs, /usr/bin/glosa and chrome-sandbox's mode
# included, so installing and upgrading run nothing (#432). This file exists only so
# electron-builder does not substitute its default script, which would link /usr/bin/glosa to the
# Electron binary and decide the sandbox mode as root. It never signals a running glosa daemon:
# the daemon notices its install changed and restarts itself (R-L5).
:
