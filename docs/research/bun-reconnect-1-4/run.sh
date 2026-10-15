#!/bin/bash
# Usage: run.sh <runtime binary>. A fresh Sentinel stack per run, one kill, then torn down.
D=$(cd "$(dirname "$0")" && pwd); C="docker compose -p rsk-t108 -f $D/sentinel.compose.yml"
$C down -v >/dev/null 2>&1; $C up -d --wait >/dev/null 2>&1
COMPOSE=$D/sentinel.compose.yml timeout 60 $1 $D/repro.mjs 2>&1 | grep -v '^\s*at '
$C down -v >/dev/null 2>&1
