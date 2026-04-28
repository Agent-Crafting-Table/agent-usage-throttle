#!/bin/sh
# preflight-gate.sh — preCommand gate for throttle-aware cron agents.
#
# Wire into cron-framework's preCommand field. The cron-runner runs this
# before spawning a Claude session — exit 1 skips the spawn silently.
#
# Usage:
#   preflight-gate.sh [--tier soft|hard]
#
#   --tier soft  Block only when soft OR hard throttle is active (default)
#   --tier hard  Block only when hard throttle is active
#
# Environment:
#   WORKSPACE_DIR          Root workspace (default: cwd)
#   THROTTLE_RUNTIME_DIR   Path to runtime dir (default: $WORKSPACE_DIR/data/runtime)
#
# Exit codes:
#   0  No throttle active at requested tier — allow spawn
#   1  Throttled — skip this tick
#   2  Usage error

WORKSPACE="${WORKSPACE_DIR:-$(pwd)}"
RUNTIME="${THROTTLE_RUNTIME_DIR:-$WORKSPACE/data/runtime}"
TIER="${1:-}"
if [ "$TIER" = "--tier" ]; then
  TIER="$2"
fi
TIER="${TIER:-soft}"

case "$TIER" in
  soft)  ;;
  hard)  ;;
  *)
    echo "usage: preflight-gate.sh [--tier soft|hard]" >&2
    exit 2
    ;;
esac

# Hard throttle blocks everything
if [ -f "$RUNTIME/THROTTLE_HARD" ]; then
  exit 1
fi

# Soft throttle blocks soft-tier agents
if [ "$TIER" = "soft" ] && [ -f "$RUNTIME/THROTTLE_SOFT" ]; then
  exit 1
fi

exit 0
