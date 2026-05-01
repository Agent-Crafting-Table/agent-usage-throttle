#!/bin/sh
# preflight-gate.sh — preCommand gate for throttle-aware cron agents.
#
# Wire into cron-framework's preCommand field. The cron-runner runs this
# before spawning a Claude session — exit 1 skips the spawn silently.
#
# Usage:
#   preflight-gate.sh [--tier soft|hard] [--agent <name>] [--log <path>]
#
#   --tier soft       Block when soft OR hard throttle is active (default)
#   --tier hard       Block only when hard throttle is active
#   --agent <name>    Snake_case agent name (e.g. "developer"). Enables the
#                     graduated zone throttle: reads
#                     THROTTLE_INTERVAL_<AGENT> and skips if the agent ran
#                     more recently than that interval requires.
#   --log <path>      Path to the agent activity log (one ISO-8601 timestamp
#                     per line, agent name appearing somewhere on the line).
#                     Defaults to $WORKSPACE_DIR/agent-log.md. Required for
#                     zone-throttle skipping; without it, only the legacy
#                     SOFT/HARD gates apply.
#
# Environment:
#   WORKSPACE_DIR          Root workspace (default: cwd)
#   THROTTLE_RUNTIME_DIR   Path to runtime dir (default: $WORKSPACE_DIR/data/runtime)
#   AGENT_LOG_FILE         Override default agent log path
#
# Exit codes:
#   0  Allowed — proceed with spawn
#   1  Throttled — skip this tick
#   2  Usage error

WORKSPACE="${WORKSPACE_DIR:-$(pwd)}"
RUNTIME="${THROTTLE_RUNTIME_DIR:-$WORKSPACE/data/runtime}"
TIER="soft"
AGENT=""
LOG="${AGENT_LOG_FILE:-$WORKSPACE/agent-log.md}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tier)   TIER="$2"; shift 2 ;;
    --agent)  AGENT="$2"; shift 2 ;;
    --log)    LOG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "usage: preflight-gate.sh [--tier soft|hard] [--agent <name>] [--log <path>]" >&2
      exit 2
      ;;
  esac
done

case "$TIER" in
  soft|hard) ;;
  *) echo "tier must be soft or hard" >&2; exit 2 ;;
esac

# Hard throttle blocks everything (legacy + new behavior).
if [ -f "$RUNTIME/THROTTLE_HARD" ]; then
  exit 1
fi

# Soft throttle blocks soft-tier agents (legacy behavior).
if [ "$TIER" = "soft" ] && [ -f "$RUNTIME/THROTTLE_SOFT" ]; then
  exit 1
fi

# Graduated zone throttle: only applied when --agent is given. The throttle
# script writes a per-agent THROTTLE_INTERVAL_<AGENT> file containing the
# minimum minutes that must elapse between runs. We compare against the most
# recent timestamp matching the agent name in the log file. Sprint zone
# writes no interval files, so this block is a no-op then.
if [ -n "$AGENT" ]; then
  agent_token=$(echo "$AGENT" | tr 'a-z-' 'A-Z_')
  INTERVAL_FILE="$RUNTIME/THROTTLE_INTERVAL_${agent_token}"
  if [ -f "$INTERVAL_FILE" ] && [ -f "$LOG" ]; then
    min_min=$(head -1 "$INTERVAL_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$min_min" ] && [ "$min_min" -gt 0 ] 2>/dev/null; then
      # Match a line containing both an ISO-8601 timestamp and the agent name
      # (case-insensitive). Adjust the regex if your log format differs.
      last_iso=$(grep -iE "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?.*${AGENT}" "$LOG" 2>/dev/null \
        | tail -1 \
        | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?' \
        | head -1)
      if [ -n "$last_iso" ]; then
        last_epoch=$(date -u -d "$last_iso" +%s 2>/dev/null || echo 0)
        now_epoch=$(date -u +%s)
        age_min=$(( (now_epoch - last_epoch) / 60 ))
        if [ "$age_min" -lt "$min_min" ]; then
          exit 1
        fi
      fi
    fi
  fi
fi

exit 0
