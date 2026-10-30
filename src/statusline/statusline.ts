#!/usr/bin/env node
// Nexus statusline — Claude Code statusLine.command
// Reads JSON session data on stdin (display_name, used_percentage, cwd, etc.)
// Cross-session cache at $CLAUDE_CONFIG_DIR/.usage_cache (default ~/.claude) prevents concurrent fetches.
// Network refreshes run as `node statusline.mjs --refresh usage|version` in a detached child —
// plain Node (fetch + fs), no sh/curl/grep, so the same code runs on macOS, Linux and Windows.

import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ── stdin ──────────────────────────────────────────────

let stdinRaw = "";
try {
  stdinRaw = readFileSync(0, "utf-8");
} catch {
  /* empty stdin */
}

function getVal(key: string): string {
  const m = stdinRaw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : "";
}
function getNum(key: string): number {
  const m = stdinRaw.match(new RegExp(`"${key}"\\s*:\\s*([0-9.]+)`));
  return m ? parseFloat(m[1]) : 0;
}

// ── paths ──────────────────────────────────────────────

function findProjectRoot(start?: string): string {
  let dir = resolve(start ?? process.cwd());
  // Stop at the filesystem root — "/" on POSIX, "C:\" on Windows (its parent is itself).
  while (resolve(dir, "..") !== dir) {
    if (existsSync(join(dir, ".git"))) return dir;
    dir = resolve(dir, "..");
  }
  return start ?? process.cwd();
}

const PROJECT_ROOT = findProjectRoot(getVal("cwd") || process.cwd());
const HOME = homedir();
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || "";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

// macOS keychain service name. Mirrors Claude Code's own algorithm:
//   default (CLAUDE_CONFIG_DIR unset) → "Claude Code-credentials"
//   custom CLAUDE_CONFIG_DIR          → "Claude Code-credentials-<sha256(NFC(envValue))[:8]>"
// Hash input is the env-var value verbatim (NFC-normalized), not a resolved path.
const KEYCHAIN_SERVICE = (() => {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (!envDir) return "Claude Code-credentials";
  const normalized = envDir.normalize("NFC");
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
})();

function getPluginVersion(): string {
  // Plugin context: Claude Code sets CLAUDE_PLUGIN_ROOT when loading from marketplace.
  if (PLUGIN_ROOT) {
    try {
      const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf-8"));
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      /* skip */
    }
  }
  // CLI context (bunx/npx/global install): read our own package.json next to the bundled script.
  try {
    const scriptDir = dirname(SCRIPT_PATH);
    const manifest = JSON.parse(readFileSync(join(scriptDir, "..", "package.json"), "utf-8"));
    if (typeof manifest.version === "string") return manifest.version;
  } catch {
    /* skip */
  }
  return "";
}

// ── colors ─────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const SEP = `${DIM}│${RESET}`;

const MODEL_COLORS: Record<string, string> = {
  opus: "\x1b[38;5;168m",
  sonnet: "\x1b[38;5;108m",
  haiku: "\x1b[38;5;67m",
};

function pctColor(pct: number): string {
  if (pct > 90) return "\x1b[31m";
  if (pct > 75) return "\x1b[38;5;208m";
  if (pct > 50) return "\x1b[33m";
  return "\x1b[32m";
}

function makeBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round((clamped * width) / 100);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function meter(label: string, pct: number, width: number): string {
  return `${DIM}${label}${RESET} ${pctColor(pct)}${makeBar(pct, width)} ${Math.round(pct)}%${RESET}`;
}

// ── Line 1: Nexus tag · model · project · branch ──────

const VERSION_CACHE_PATH = join(CLAUDE_CONFIG_DIR, ".nexus_version_cache");
const VERSION_CACHE_TTL = 86400; // 24h

function updateAvailable(current: string): boolean {
  if (!current) return false;
  const now = Math.floor(Date.now() / 1000);

  if (existsSync(VERSION_CACHE_PATH)) {
    try {
      const lines = readFileSync(VERSION_CACHE_PATH, "utf-8").split("\n");
      const cachedAt = parseInt(lines[0]);
      const latest = lines[1]?.trim() || "";
      if (now - cachedAt < VERSION_CACHE_TTL && latest) {
        return latest !== current && latest > current;
      }
    } catch {
      /* skip */
    }
  }

  spawnRefresh("version");

  if (existsSync(VERSION_CACHE_PATH)) {
    try {
      const lines = readFileSync(VERSION_CACHE_PATH, "utf-8").split("\n");
      const latest = lines[1]?.trim() || "";
      if (latest) return latest !== current && latest > current;
    } catch {
      /* skip */
    }
  }
  return false;
}

function buildLine1(): string {
  const model = getVal("display_name") || "unknown";
  const modelLower = model.toLowerCase();
  const modelColor = Object.entries(MODEL_COLORS).find(([k]) => modelLower.includes(k))?.[1] ?? "\x1b[37m";

  const project = basename(PROJECT_ROOT);

  let gitPart = `${DIM}—${RESET}`;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const staged = execSync("git diff --cached --numstat", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean).length;
    const unstaged = execSync("git diff --numstat", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean).length;
    let dirty = "";
    if (staged > 0) dirty += `\x1b[32m+${staged}${RESET}`;
    if (unstaged > 0) dirty += `\x1b[33m~${unstaged}${RESET}`;
    gitPart = dirty ? `${branch} (${dirty})` : branch;
  } catch {
    /* skip */
  }

  const version = getPluginVersion();
  const canUpdate = version ? updateAvailable(version) : false;
  const versionStr = version ? ` v${version}` : "";
  const updateTag = canUpdate ? ` \x1b[33m↑${RESET}` : "";
  const nexusTag = `\x1b[38;5;141m◆Nexus${versionStr}${RESET}${updateTag}`;

  return `${nexusTag} ${SEP} ${modelColor}${BOLD}${model}${RESET} ${SEP} \x1b[36m${project}${RESET} ${SEP} ${gitPart}`;
}

// ── Line 2: ctx · 5h · 7d with cross-session cache ────

const USAGE_CACHE_PATH = join(CLAUDE_CONFIG_DIR, ".usage_cache");
const CACHE_TTL_DEFAULT = 60; // s
const FETCH_BACKOFF = 300; // s on failure
const STALE_THRESHOLD = 300; // show "ago" when data older than 5 min

function writeAtomic(path: string, content: string): void {
  try {
    writeFileSync(path + ".tmp", content);
    renameSync(path + ".tmp", path);
  } catch {
    try {
      unlinkSync(path + ".tmp");
    } catch {
      /* skip */
    }
  }
}

/**
 * Usage cache format (3 lines):
 *   {data_timestamp}     — when the data was actually fetched (for stale indicator)
 *   {next_fetch_after}   — no new fetch allowed before this (dedupe across sessions)
 *   {response_json}
 */
function readUsageCache(): { dataTimestamp: number; nextFetchAfter: number; cachedData: string } {
  const out = { dataTimestamp: 0, nextFetchAfter: 0, cachedData: "" };
  if (!existsSync(USAGE_CACHE_PATH)) return out;
  try {
    const lines = readFileSync(USAGE_CACHE_PATH, "utf-8").split("\n");
    out.dataTimestamp = parseInt(lines[0]) || 0;
    const line1 = parseInt(lines[1]) || 0;
    // legacy format kept a ttl on line 2
    out.nextFetchAfter = line1 > 1_000_000 ? line1 : out.dataTimestamp + (line1 || CACHE_TTL_DEFAULT);
    out.cachedData = lines[2] || "";
  } catch {
    /* skip */
  }
  return out;
}

/**
 * Claude Code's own OAuth access token (claudeAiOauth.accessToken).
 * The credentials JSON also holds MCP servers' OAuth entries (mcpOAuth.*.accessToken, possibly empty),
 * so matching the first "accessToken" in the text can pick one of those instead.
 */
function readAccessToken(): string {
  try {
    let credJson = "";
    if (process.platform === "darwin") {
      credJson = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // Linux and Windows: $CLAUDE_CONFIG_DIR/.credentials.json
      const credFile = join(CLAUDE_CONFIG_DIR, ".credentials.json");
      if (existsSync(credFile)) credJson = readFileSync(credFile, "utf-8");
    }
    const token = JSON.parse(credJson)?.claudeAiOauth?.accessToken;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

/** Child mode `--refresh usage`: fetch → cache. On failure keep the old data and back off. */
async function refreshUsage(): Promise<void> {
  const token = readAccessToken();
  let resp = "";
  if (token) {
    try {
      const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(3000),
      });
      const body = await r.json();
      if (body && typeof body === "object" && "five_hour" in body) resp = JSON.stringify(body); // one line for the cache
    } catch {
      /* skip */
    }
  }
  const now = Math.floor(Date.now() / 1000);
  if (resp) {
    writeAtomic(USAGE_CACHE_PATH, `${now}\n${now + CACHE_TTL_DEFAULT}\n${resp}\n`);
    return;
  }
  const { dataTimestamp, cachedData } = readUsageCache();
  if (cachedData) writeAtomic(USAGE_CACHE_PATH, `${dataTimestamp}\n${now + FETCH_BACKOFF}\n${cachedData}\n`);
}

/** Child mode `--refresh version`: latest GitHub release → version cache. */
async function refreshVersion(): Promise<void> {
  try {
    const r = await fetch("https://api.github.com/repos/moreih29/claude-nexus/releases/latest", {
      headers: { "User-Agent": "claude-nexus-statusline", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(3000),
    });
    const tag = ((await r.json()) as { tag_name?: unknown } | null)?.tag_name;
    if (typeof tag === "string" && tag) {
      writeAtomic(VERSION_CACHE_PATH, `${Math.floor(Date.now() / 1000)}\n${tag.replace(/^v/, "")}\n`);
    }
  } catch {
    /* skip */
  }
}

/** Run a refresh in a detached child of the same runtime (node or bun) — the statusline itself never waits. */
function spawnRefresh(kind: "usage" | "version"): void {
  try {
    const child = spawn(process.execPath, [SCRIPT_PATH, "--refresh", kind], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {
      /* skip */
    });
    child.unref();
  } catch {
    /* skip */
  }
}

function readUsage(): { json: string; stale: boolean; ageSeconds: number } | null {
  const now = Math.floor(Date.now() / 1000);
  let { dataTimestamp, nextFetchAfter, cachedData } = readUsageCache();
  const age = () => (dataTimestamp > 0 ? now - dataTimestamp : 0);

  if (cachedData && now < nextFetchAfter) {
    return { json: cachedData, stale: age() >= STALE_THRESHOLD, ageSeconds: age() };
  }

  if (cachedData) {
    // Claim next_fetch_after immediately so concurrent sessions don't re-fetch.
    writeAtomic(USAGE_CACHE_PATH, `${dataTimestamp}\n${now + CACHE_TTL_DEFAULT}\n${cachedData}\n`);
    spawnRefresh("usage");
    return { json: cachedData, stale: age() >= STALE_THRESHOLD, ageSeconds: age() };
  }

  // First run — wait for one refresh, then read what it cached.
  try {
    spawnSync(process.execPath, [SCRIPT_PATH, "--refresh", "usage"], { stdio: "ignore", timeout: 5000, windowsHide: true });
  } catch {
    /* skip */
  }
  ({ dataTimestamp, cachedData } = readUsageCache());
  if (cachedData) return { json: cachedData, stale: false, ageSeconds: 0 };
  return null;
}

function utilPct(parsed: Record<string, unknown> | null, section: string): number {
  if (!parsed) return 0;
  const data = parsed[section] as Record<string, unknown> | undefined;
  return Number(data?.utilization) || 0;
}

function resetRemain(
  parsed: Record<string, unknown> | null,
  section: string,
): { remaining: string; remainingCoarse: string } {
  const empty = { remaining: "", remainingCoarse: "" };
  if (!parsed) return empty;
  const data = parsed[section] as Record<string, unknown> | undefined;
  const resetAt = data?.resets_at as string | undefined;
  if (!resetAt) return empty;
  try {
    const d = new Date(resetAt);
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) return empty;
    const diffMin = Math.floor(diffMs / 60000);
    const hh = Math.floor(diffMin / 60);
    const mm = diffMin % 60;
    const remaining = hh > 0 ? `${hh}h${mm}m` : `${mm}m`;
    const dd = Math.floor(hh / 24);
    const hhRem = hh % 24;
    const remainingCoarse = dd > 0 ? `${dd}d${hhRem}h` : `${hh}h`;
    return { remaining, remainingCoarse };
  } catch {
    return empty;
  }
}

function isApiMode(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// ── API cost (local jsonl scan) ───────────────────────
// Sums today's token usage across all Claude Code sessions on this machine and
// converts to USD using a hardcoded model price table. Avoids needing an
// ANTHROPIC_ADMIN_KEY (cost_report admin endpoint) — works for every API mode user.
//
// "Today" = UTC midnight → next UTC midnight, matching Claude Code desktop app.
//
// Price table source: https://platform.claude.com/docs/en/about-claude/pricing
// Cache pricing rule: cache_5m = 1.25× input, cache_1h = 2× input, cache_read = 0.1× input.

const COST_CACHE_PATH = join(CLAUDE_CONFIG_DIR, ".api_cost_cache");
const COST_CACHE_TTL = 60; // s
const COST_STALE_THRESHOLD = 300; // s — mark stale at 5 min

interface ModelRates {
  input: number; // USD per token (already divided by 1e6)
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
}

/**
 * Map a Claude API model name (e.g. "claude-opus-4-7", "claude-3-5-sonnet-20241022")
 * to per-token USD rates. Returns null for unknown models so they're excluded
 * from the total rather than mis-priced. Verified 2026-04 against pricing page.
 */
function priceFor(model: string): ModelRates | null {
  const m = model.toLowerCase();
  // [pattern, base $/MTok input, $/MTok output]
  const TABLE: Array<[RegExp, number, number]> = [
    [/opus-4-[5-9]/, 5, 25], // Opus 4.5 / 4.6 / 4.7
    [/opus-(?:4-[01]|4)(?:[-_]|$)/, 15, 75], // Opus 4 / 4.1
    [/opus-3/, 15, 75], // Opus 3 (deprecated)
    [/sonnet-4(?:-\d+)?(?:[-_]|$)|4-sonnet/, 3, 15], // Sonnet 4 / 4.5 / 4.6
    [/sonnet-3-7|3-7-sonnet/, 3, 15], // Sonnet 3.7 (deprecated)
    [/sonnet-3-5|3-5-sonnet/, 3, 15], // Sonnet 3.5 (legacy, same rate)
    [/haiku-4-5/, 1, 5],
    [/haiku-3-5|3-5-haiku/, 0.8, 4],
    [/haiku-3/, 0.25, 1.25],
  ];
  for (const [re, inp, out] of TABLE) {
    if (re.test(m)) {
      const inputPerToken = inp / 1e6;
      return {
        input: inputPerToken,
        output: out / 1e6,
        cache5m: inputPerToken * 1.25,
        cache1h: inputPerToken * 2,
        cacheRead: inputPerToken * 0.1,
      };
    }
  }
  return null;
}

interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

function turnCostUsd(model: string, usage: TurnUsage): number {
  const rates = priceFor(model);
  if (!rates) return 0;
  const inp = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  // Prefer detailed 5m/1h split if present; else fall back to the aggregate
  // cache_creation_input_tokens at 5m rate (the safer/cheaper assumption).
  const c5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const c1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  let cacheWriteCost = 0;
  if (c5m !== undefined || c1h !== undefined) {
    cacheWriteCost = (c5m ?? 0) * rates.cache5m + (c1h ?? 0) * rates.cache1h;
  } else {
    cacheWriteCost = (usage.cache_creation_input_tokens ?? 0) * rates.cache5m;
  }
  return inp * rates.input + out * rates.output + cacheRead * rates.cacheRead + cacheWriteCost;
}

/**
 * Walk ~/.claude/projects/<encoded>/<session>.jsonl and sum cost for assistant
 * turns whose timestamp falls within today's UTC bucket. Returns USD or null
 * when the projects directory is missing entirely.
 *
 * Performance: project files modified before today's UTC midnight are skipped
 * by mtime so heavy users don't re-scan archival sessions on every render.
 */
function scanLocalCostUsd(): number | null {
  const projectsRoot = join(CLAUDE_CONFIG_DIR, "projects");
  if (!existsSync(projectsRoot)) return null;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  let total = 0;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }

  for (const proj of projectDirs) {
    const projPath = join(projectsRoot, proj);
    let entries: string[];
    try {
      entries = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const fp = join(projPath, file);
      try {
        const st = statSync(fp);
        // Skip files whose last modification is before today — they cannot
        // contain today-bucket entries.
        if (st.mtimeMs < todayStartMs) continue;
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(fp, "utf-8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      for (const line of lines) {
        if (!line || !line.includes('"assistant"')) continue;
        let entry: {
          type?: string;
          timestamp?: string;
          message?: { model?: string; usage?: TurnUsage };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== "assistant") continue;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < todayStartMs) continue;
        const model = entry.message?.model;
        const usage = entry.message?.usage;
        if (!model || !usage) continue;
        total += turnCostUsd(model, usage);
      }
    }
  }
  return total;
}

/**
 * Returns today's API cost in USD with a 60s cache. `null` only when the
 * Claude projects directory itself is missing (i.e., new install with no
 * sessions yet). $0 is a valid result for "no usage today."
 */
function readApiCost(): { cost: number | null; stale: boolean; ageSeconds: number } {
  const now = Math.floor(Date.now() / 1000);
  let dataTimestamp = 0;
  let nextRescanAfter = 0;
  let cachedValue = "";

  if (existsSync(COST_CACHE_PATH)) {
    try {
      const lines = readFileSync(COST_CACHE_PATH, "utf-8").split("\n");
      dataTimestamp = parseInt(lines[0]) || 0;
      nextRescanAfter = parseInt(lines[1]) || 0;
      cachedValue = (lines[2] || "").trim();
    } catch {
      /* skip */
    }
  }

  const age = dataTimestamp > 0 ? now - dataTimestamp : 0;
  const parseCached = (): number | null => {
    if (!cachedValue) return null;
    const n = parseFloat(cachedValue);
    return Number.isFinite(n) ? n : null;
  };

  if (cachedValue && now < nextRescanAfter) {
    return { cost: parseCached(), stale: age >= COST_STALE_THRESHOLD, ageSeconds: age };
  }

  // Synchronous re-scan. Local I/O only; mtime filter keeps it fast.
  const cost = scanLocalCostUsd();
  if (cost === null) {
    return { cost: null, stale: false, ageSeconds: 0 };
  }
  writeAtomic(COST_CACHE_PATH, `${now}\n${now + COST_CACHE_TTL}\n${cost}`);
  return { cost, stale: false, ageSeconds: 0 };
}

function buildLine2(): string {
  const BAR_WIDTH = 6;
  const ctxPct = Math.round(getNum("used_percentage"));
  const ctx = meter("ctx", ctxPct, BAR_WIDTH);

  if (isApiMode()) {
    const { cost, stale, ageSeconds } = readApiCost();
    if (cost !== null) {
      let stalePart = "";
      if (stale) {
        const ageMin = Math.floor(ageSeconds / 60);
        const hh = Math.floor(ageMin / 60);
        const mm = ageMin % 60;
        const ageStr = hh > 0 ? `${hh}h${mm}m` : `${mm}m`;
        stalePart = ` ${SEP} \x1b[33m${ageStr} ago\x1b[0m`;
      }
      return `${ctx} ${SEP} ${DIM}API${RESET} ${pctColor(0)}$${cost.toFixed(2)} today${RESET}${stalePart}`;
    }
    // No projects directory yet (fresh install) — fall through to the dim label.
    return `${ctx} ${SEP} ${DIM}API mode${RESET}`;
  }

  const noData = (label: string) => `${DIM}${label} ${"░".repeat(BAR_WIDTH)} --%${RESET}`;

  const usage = readUsage();
  if (!usage || !usage.json) {
    return `${ctx} ${SEP} ${noData("5h")} ${SEP} ${noData("7d")}`;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(usage.json);
  } catch {
    /* skip */
  }

  if (!parsed) {
    return `${ctx} ${SEP} ${noData("5h")} ${SEP} ${noData("7d")}`;
  }

  const pct5h = Math.round(utilPct(parsed, "five_hour"));
  const pct7d = Math.round(utilPct(parsed, "seven_day"));
  const { remaining: r5h } = resetRemain(parsed, "five_hour");
  const { remainingCoarse: r7d } = resetRemain(parsed, "seven_day");

  const m5h = meter("5h", pct5h, BAR_WIDTH);
  const m7d = meter("7d", pct7d, BAR_WIDTH);
  const tag5h = r5h ? ` ${DIM}↻${r5h}${RESET}` : "";
  const tag7d = r7d ? ` ${DIM}↻${r7d}${RESET}` : "";

  let stalePart = "";
  if (usage.stale) {
    const ageMin = Math.floor(usage.ageSeconds / 60);
    const hh = Math.floor(ageMin / 60);
    const mm = ageMin % 60;
    const ageStr = hh > 0 ? `${hh}h${mm}m` : `${mm}m`;
    stalePart = ` ${SEP} \x1b[33m${ageStr} ago\x1b[0m`;
  }

  return `${ctx} ${SEP} ${m5h}${tag5h} ${SEP} ${m7d}${tag7d}${stalePart}`;
}

// ── main ───────────────────────────────────────────────

function main(): void {
  process.stdout.write(buildLine1() + "\n" + buildLine2() + "\n");
}

const refreshKind = process.argv[2] === "--refresh" ? process.argv[3] : "";
if (refreshKind === "usage" || refreshKind === "version") {
  (refreshKind === "usage" ? refreshUsage() : refreshVersion()).finally(() => process.exit(0));
} else {
  try {
    main();
  } catch {
    process.stdout.write("nexus\n");
  }
}
