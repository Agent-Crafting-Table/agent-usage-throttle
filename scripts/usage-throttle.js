#!/usr/bin/env node
/**
 * usage-throttle.js — Two-tier token budget throttle for Claude Code pipelines.
 *
 * Reads weekTotal.estimatedCostUSD from data/claude-usage-cache.json (generated
 * by usage-stats.js) and manages two signal files in a runtime directory:
 *
 *   THROTTLE_SOFT — soft limit hit: pause write-heavy agents (Developer, PM…)
 *   THROTTLE_HARD — hard limit hit: pause all agents
 *
 * These files are checked by preflight-gate.sh before each agent spawn via the
 * cron-framework preCommand field. An absent file = allowed; present = blocked.
 *
 * Thresholds (with hysteresis to prevent flapping):
 *   >= SOFT_PCT  → set SOFT    |  < (SOFT_PCT - 5%)  → clear SOFT
 *   >= HARD_PCT  → set HARD    |  < (HARD_PCT - 5%)  → clear HARD
 *
 * Configure via environment or .env:
 *   WEEKLY_USD_BUDGET     (default: 1700)  estimated cost budget per week
 *   THROTTLE_SOFT_PCT     (default: 70)    soft pause threshold %
 *   THROTTLE_HARD_PCT     (default: 90)    hard pause threshold %
 *   THROTTLE_RUNTIME_DIR  path to runtime dir (default: data/runtime)
 *   USAGE_CACHE_FILE      path to cache JSON (default: data/claude-usage-cache.json)
 *   DISCORD_POST_SCRIPT   optional: node <path> <channel_id> <message> for alerts
 *   DISCORD_CHANNEL_ID    channel to post throttle state change alerts
 *
 * Schedule: run hourly via cron-framework (runner: "shell").
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();

// Load .env if present
try {
  fs.readFileSync(path.join(WORKSPACE, '.env'), 'utf8')
    .split('\n').forEach(l => {
      const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
} catch {}

const RUNTIME    = process.env.THROTTLE_RUNTIME_DIR || path.join(WORKSPACE, 'data/runtime');
const CACHE_FILE = process.env.USAGE_CACHE_FILE     || path.join(WORKSPACE, 'data/claude-usage-cache.json');
const SOFT_FILE  = path.join(RUNTIME, 'THROTTLE_SOFT');
const HARD_FILE  = path.join(RUNTIME, 'THROTTLE_HARD');

const BUDGET   = parseFloat(process.env.WEEKLY_USD_BUDGET  || '1700');
const SOFT_PCT = parseInt(process.env.THROTTLE_SOFT_PCT    || '70') / 100;
const HARD_PCT = parseInt(process.env.THROTTLE_HARD_PCT    || '90') / 100;
const SOFT_CLEAR = SOFT_PCT - 0.05;
const HARD_CLEAR = HARD_PCT - 0.05;

function getWeeklyEstimatedCost() {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return (cache.weekTotal && cache.weekTotal.estimatedCostUSD) || 0;
  } catch {
    return 0;
  }
}

function postDiscord(msg) {
  const script  = process.env.DISCORD_POST_SCRIPT;
  const channel = process.env.DISCORD_CHANNEL_ID;
  if (!script || !channel) return;
  try {
    const { spawnSync } = require('child_process');
    spawnSync('node', [script, channel, msg], { cwd: WORKSPACE, timeout: 5000 });
  } catch {}
}

function main() {
  fs.mkdirSync(RUNTIME, { recursive: true });

  const used    = getWeeklyEstimatedCost();
  const pct     = used / BUDGET;
  const pctStr  = (pct * 100).toFixed(1);
  const usedStr = used.toFixed(0);
  const budStr  = BUDGET.toFixed(0);

  const wasSoft = fs.existsSync(SOFT_FILE);
  const wasHard = fs.existsSync(HARD_FILE);
  let nowSoft = wasSoft;
  let nowHard = wasHard;

  // Hard tier
  if (pct >= HARD_PCT && !wasHard)  nowHard = true;
  else if (pct < HARD_CLEAR && wasHard) nowHard = false;

  // Soft tier
  if (pct >= SOFT_PCT && !wasSoft)  nowSoft = true;
  else if (pct < SOFT_CLEAR && wasSoft) nowSoft = false;

  if (nowHard) nowSoft = true; // hard implies soft

  // Apply changes + notify
  if (nowHard && !wasHard) {
    fs.writeFileSync(HARD_FILE, `hard throttle — ${pctStr}% of $${budStr} budget ($${usedStr})\n`);
    postDiscord(`🔴 **HARD THROTTLE** — ${pctStr}% of weekly budget used ($${usedStr} / $${budStr} est.). All agents paused until weekly reset.`);
  } else if (!nowHard && wasHard) {
    fs.unlinkSync(HARD_FILE);
    postDiscord(`✅ **Hard throttle cleared** — back below ${Math.round(HARD_CLEAR * 100)}% ($${usedStr} / $${budStr}). All agents resuming.`);
  }

  if (nowSoft && !wasSoft) {
    fs.writeFileSync(SOFT_FILE, `soft throttle — ${pctStr}% of $${budStr} budget ($${usedStr})\n`);
    if (!nowHard) {
      postDiscord(`🟡 **SOFT THROTTLE** — ${pctStr}% of weekly budget used ($${usedStr} / $${budStr} est.). Write-heavy agents paused; reviewers still running.`);
    }
  } else if (!nowSoft && wasSoft) {
    fs.unlinkSync(SOFT_FILE);
    if (!wasHard) {
      postDiscord(`✅ **Soft throttle cleared** — back below ${Math.round(SOFT_CLEAR * 100)}% ($${usedStr} / $${budStr}). Full pipeline resuming.`);
    }
  }

  console.log(`[usage-throttle] $${usedStr} / $${budStr} est. weekly cost (${pctStr}%) — soft=${nowSoft} hard=${nowHard}`);
}

main();
