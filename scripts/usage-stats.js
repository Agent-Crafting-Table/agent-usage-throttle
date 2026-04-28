#!/usr/bin/env node
/**
 * usage-stats.js — Aggregates Claude Code token usage from session JSONL files.
 *
 * Scans ~/.claude/projects/ for assistant turns with usage data, produces a
 * daily breakdown and a weekly total keyed to your plan's reset schedule.
 *
 * Output: data/claude-usage-cache.json
 *
 * Schema:
 *   generatedAt  — ISO timestamp
 *   days         — [{ date, sessions, inputTokens, outputTokens,
 *                     cacheCreateTokens, cacheReadTokens, models }]
 *   weekTotal    — { inputTokens, outputTokens, cacheCreateTokens,
 *                    cacheReadTokens, estimatedCostUSD }
 *   todayTotal   — same shape
 *   weekResetAt  — ISO timestamp of last reset
 *   nextResetAt  — ISO timestamp of next reset
 *
 * Reset schedule config (via environment or .env):
 *   USAGE_RESET_DAY   Day of week for weekly reset: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
 *                     Default: 4 (Thursday — Anthropic Max plan)
 *                     Set to -1 to use a fixed monthly reset date instead
 *   USAGE_RESET_HOUR  UTC hour of the reset (default: 2, i.e. 2:00 AM UTC)
 *   USAGE_RESET_DOM   Day of month for monthly reset (only used when USAGE_RESET_DAY=-1)
 *                     Default: 1 (1st of the month — common for API / Pro plans)
 *
 * Run on a schedule (e.g. every 30 minutes) so usage-throttle.js always has
 * fresh data.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE    = process.env.WORKSPACE_DIR || process.cwd();
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR
  || path.join(process.env.HOME || '/root', '.claude/projects/-workspace');
const OUTPUT_FILE  = path.join(WORKSPACE, 'data/claude-usage-cache.json');
const DAYS_TO_SCAN = 14;

// API pricing (USD/M tokens) — used to compute estimatedCostUSD.
// The throttle uses this as a model-weighted proxy for Max plan usage.
const PRICING = {
  default:         { input: 3.00,  output: 15.00, cacheCreate: 3.75,  cacheRead: 0.30 },
  'claude-opus':   { input: 15.00, output: 75.00, cacheCreate: 18.75, cacheRead: 1.50 },
  'claude-sonnet': { input: 3.00,  output: 15.00, cacheCreate: 3.75,  cacheRead: 0.30 },
  'claude-haiku':  { input: 0.80,  output: 4.00,  cacheCreate: 1.00,  cacheRead: 0.08 },
};

function getPricing(model) {
  if (!model) return PRICING.default;
  const m = model.toLowerCase();
  if (m.includes('opus'))   return PRICING['claude-opus'];
  if (m.includes('haiku'))  return PRICING['claude-haiku'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet'];
  return PRICING.default;
}

function estimateCost(tokens, model) {
  const p = getPricing(model);
  return (
    (tokens.inputTokens        || 0) / 1e6 * p.input +
    (tokens.outputTokens       || 0) / 1e6 * p.output +
    (tokens.cacheCreateTokens  || 0) / 1e6 * p.cacheCreate +
    (tokens.cacheReadTokens    || 0) / 1e6 * p.cacheRead
  );
}

// Reset schedule — configurable via env vars.
const RESET_DAY  = parseInt(process.env.USAGE_RESET_DAY  ?? '4');  // 4 = Thursday
const RESET_HOUR = parseInt(process.env.USAGE_RESET_HOUR ?? '2');  // 2am UTC
const RESET_DOM  = parseInt(process.env.USAGE_RESET_DOM  ?? '1');  // day-of-month (monthly mode)

function getLastReset() {
  const now = new Date();

  if (RESET_DAY === -1) {
    // Monthly reset: e.g. 1st of each month at RESET_HOUR UTC
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), RESET_DOM, RESET_HOUR, 0, 0));
    if (d.getTime() > now.getTime()) {
      d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, RESET_DOM, RESET_HOUR, 0, 0));
    }
    return d.getTime();
  }

  // Weekly reset on RESET_DAY at RESET_HOUR UTC
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RESET_HOUR, 0, 0));
  const daysBack = (d.getUTCDay() - RESET_DAY + 7) % 7;
  d.setUTCDate(d.getUTCDate() - daysBack);
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  return d.getTime();
}

function getNextReset() {
  if (RESET_DAY === -1) {
    const now = new Date();
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), RESET_DOM, RESET_HOUR, 0, 0));
    if (d.getTime() <= now.getTime()) {
      d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, RESET_DOM, RESET_HOUR, 0, 0));
    }
    return d.getTime();
  }
  return getLastReset() + 7 * 24 * 3600 * 1000;
}

function main() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error('Claude projects dir not found:', PROJECTS_DIR);
    console.error('Set CLAUDE_PROJECTS_DIR env var to the right path.');
    process.exit(1);
  }

  const cutoff = Date.now() - DAYS_TO_SCAN * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ file: path.join(PROJECTS_DIR, f), mtime: fs.statSync(path.join(PROJECTS_DIR, f)).mtimeMs }))
    .filter(f => f.mtime >= cutoff)
    .sort((a, b) => a.mtime - b.mtime);

  console.log(`Scanning ${files.length} JSONL files from last ${DAYS_TO_SCAN} days...`);

  const dayMap = {};

  for (const { file } of files) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n'); }
    catch { continue; }

    const sessionId = path.basename(file, '.jsonl');

    for (const raw of lines) {
      let d;
      try { d = JSON.parse(raw); } catch { continue; }
      if (d.type !== 'assistant' || !d.message?.usage || !d.timestamp) continue;
      if (new Date(d.timestamp).getTime() < cutoff) continue;

      const usage = d.message.usage;
      const model = d.message.model || 'unknown';
      const day   = d.timestamp.slice(0, 10);

      if (!dayMap[day]) {
        dayMap[day] = { date: day, sessions: new Set(), inputTokens: 0, outputTokens: 0,
          cacheCreateTokens: 0, cacheReadTokens: 0, models: {}, _costs: 0 };
      }
      const e = dayMap[day];
      e.sessions.add(sessionId);
      e.inputTokens       += usage.input_tokens                || 0;
      e.outputTokens      += usage.output_tokens               || 0;
      e.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
      e.cacheReadTokens   += usage.cache_read_input_tokens     || 0;
      e.models[model]      = (e.models[model] || 0) + 1;
      e._costs            += estimateCost({
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreateTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
      }, model);
    }
  }

  // Build days array
  const now = new Date();
  const days = [];
  for (let i = DAYS_TO_SCAN - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (dayMap[key]) {
      const e = dayMap[key];
      days.push({ ...e, sessions: e.sessions.size, estimatedCostUSD: e._costs });
      delete days[days.length - 1]._costs;
    } else {
      days.push({ date: key, sessions: 0, inputTokens: 0, outputTokens: 0,
        cacheCreateTokens: 0, cacheReadTokens: 0, models: {}, estimatedCostUSD: 0 });
    }
  }

  // Period total (since last reset)
  const weekReset = getLastReset();
  const weekTotal = { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, estimatedCostUSD: 0 };
  for (const [day, e] of Object.entries(dayMap)) {
    if (new Date(day + 'T00:00:00Z').getTime() >= weekReset) {
      weekTotal.inputTokens       += e.inputTokens;
      weekTotal.outputTokens      += e.outputTokens;
      weekTotal.cacheCreateTokens += e.cacheCreateTokens;
      weekTotal.cacheReadTokens   += e.cacheReadTokens;
      weekTotal.estimatedCostUSD  += e._costs;
    }
  }

  // Today total
  const todayKey = now.toISOString().slice(0, 10);
  const todayE   = dayMap[todayKey];
  const todayTotal = todayE
    ? { inputTokens: todayE.inputTokens, outputTokens: todayE.outputTokens,
        cacheCreateTokens: todayE.cacheCreateTokens, cacheReadTokens: todayE.cacheReadTokens,
        estimatedCostUSD: todayE._costs }
    : { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, estimatedCostUSD: 0 };

  const output = {
    generatedAt: now.toISOString(),
    filesScanned: files.length,
    days,
    weekTotal,
    todayTotal,
    weekResetAt: new Date(weekReset).toISOString(),
    nextResetAt: new Date(getNextReset()).toISOString(),
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Written: ${OUTPUT_FILE}`);
  console.log(`Week total: $${weekTotal.estimatedCostUSD.toFixed(0)} est. cost, ${(weekTotal.outputTokens/1e6).toFixed(1)}M output tokens`);
}

main();
