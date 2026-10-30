#!/usr/bin/env node

// src/statusline/statusline.ts
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
var stdinRaw = "";
try {
  stdinRaw = readFileSync(0, "utf-8");
} catch {}
function getVal(key) {
  const m = stdinRaw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : "";
}
function getNum(key) {
  const m = stdinRaw.match(new RegExp(`"${key}"\\s*:\\s*([0-9.]+)`));
  return m ? parseFloat(m[1]) : 0;
}
function findProjectRoot(start) {
  let dir = resolve(start ?? process.cwd());
  while (resolve(dir, "..") !== dir) {
    if (existsSync(join(dir, ".git")))
      return dir;
    dir = resolve(dir, "..");
  }
  return start ?? process.cwd();
}
var PROJECT_ROOT = findProjectRoot(getVal("cwd") || process.cwd());
var HOME = homedir();
var CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
var PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || "";
var SCRIPT_PATH = fileURLToPath(import.meta.url);
var KEYCHAIN_SERVICE = (() => {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (!envDir)
    return "Claude Code-credentials";
  const normalized = envDir.normalize("NFC");
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
})();
function getPluginVersion() {
  if (PLUGIN_ROOT) {
    try {
      const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf-8"));
      if (typeof manifest.version === "string")
        return manifest.version;
    } catch {}
  }
  try {
    const scriptDir = dirname(SCRIPT_PATH);
    const manifest = JSON.parse(readFileSync(join(scriptDir, "..", "package.json"), "utf-8"));
    if (typeof manifest.version === "string")
      return manifest.version;
  } catch {}
  return "";
}
var RESET = "\x1B[0m";
var BOLD = "\x1B[1m";
var DIM = "\x1B[2m";
var SEP = `${DIM}│${RESET}`;
var MODEL_COLORS = {
  opus: "\x1B[38;5;168m",
  sonnet: "\x1B[38;5;108m",
  haiku: "\x1B[38;5;67m"
};
function pctColor(pct) {
  if (pct > 90)
    return "\x1B[31m";
  if (pct > 75)
    return "\x1B[38;5;208m";
  if (pct > 50)
    return "\x1B[33m";
  return "\x1B[32m";
}
function makeBar(pct, width) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round(clamped * width / 100);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}
function meter(label, pct, width) {
  return `${DIM}${label}${RESET} ${pctColor(pct)}${makeBar(pct, width)} ${Math.round(pct)}%${RESET}`;
}
var VERSION_CACHE_PATH = join(CLAUDE_CONFIG_DIR, ".nexus_version_cache");
var VERSION_CACHE_TTL = 86400;
function updateAvailable(current) {
  if (!current)
    return false;
  const now = Math.floor(Date.now() / 1000);
  if (existsSync(VERSION_CACHE_PATH)) {
    try {
      const lines = readFileSync(VERSION_CACHE_PATH, "utf-8").split(`
`);
      const cachedAt = parseInt(lines[0]);
      const latest = lines[1]?.trim() || "";
      if (now - cachedAt < VERSION_CACHE_TTL && latest) {
        return latest !== current && latest > current;
      }
    } catch {}
  }
  spawnRefresh("version");
  if (existsSync(VERSION_CACHE_PATH)) {
    try {
      const lines = readFileSync(VERSION_CACHE_PATH, "utf-8").split(`
`);
      const latest = lines[1]?.trim() || "";
      if (latest)
        return latest !== current && latest > current;
    } catch {}
  }
  return false;
}
function buildLine1() {
  const model = getVal("display_name") || "unknown";
  const modelLower = model.toLowerCase();
  const modelColor = Object.entries(MODEL_COLORS).find(([k]) => modelLower.includes(k))?.[1] ?? "\x1B[37m";
  const project = basename(PROJECT_ROOT);
  let gitPart = `${DIM}—${RESET}`;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    const staged = execSync("git diff --cached --numstat", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim().split(`
`).filter(Boolean).length;
    const unstaged = execSync("git diff --numstat", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim().split(`
`).filter(Boolean).length;
    let dirty = "";
    if (staged > 0)
      dirty += `\x1B[32m+${staged}${RESET}`;
    if (unstaged > 0)
      dirty += `\x1B[33m~${unstaged}${RESET}`;
    gitPart = dirty ? `${branch} (${dirty})` : branch;
  } catch {}
  const version = getPluginVersion();
  const canUpdate = version ? updateAvailable(version) : false;
  const versionStr = version ? ` v${version}` : "";
  const updateTag = canUpdate ? ` \x1B[33m↑${RESET}` : "";
  const nexusTag = `\x1B[38;5;141m◆Nexus${versionStr}${RESET}${updateTag}`;
  return `${nexusTag} ${SEP} ${modelColor}${BOLD}${model}${RESET} ${SEP} \x1B[36m${project}${RESET} ${SEP} ${gitPart}`;
}
var USAGE_CACHE_PATH = join(CLAUDE_CONFIG_DIR, ".usage_cache");
var CACHE_TTL_DEFAULT = 60;
var FETCH_BACKOFF = 300;
var STALE_THRESHOLD = 300;
function writeAtomic(path, content) {
  try {
    writeFileSync(path + ".tmp", content);
    renameSync(path + ".tmp", path);
  } catch {
    try {
      unlinkSync(path + ".tmp");
    } catch {}
  }
}
function readUsageCache() {
  const out = { dataTimestamp: 0, nextFetchAfter: 0, cachedData: "" };
  if (!existsSync(USAGE_CACHE_PATH))
    return out;
  try {
    const lines = readFileSync(USAGE_CACHE_PATH, "utf-8").split(`
`);
    out.dataTimestamp = parseInt(lines[0]) || 0;
    const line1 = parseInt(lines[1]) || 0;
    out.nextFetchAfter = line1 > 1e6 ? line1 : out.dataTimestamp + (line1 || CACHE_TTL_DEFAULT);
    out.cachedData = lines[2] || "";
  } catch {}
  return out;
}
function readAccessToken() {
  try {
    let credJson = "";
    if (process.platform === "darwin") {
      credJson = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else {
      const credFile = join(CLAUDE_CONFIG_DIR, ".credentials.json");
      if (existsSync(credFile))
        credJson = readFileSync(credFile, "utf-8");
    }
    const token = JSON.parse(credJson)?.claudeAiOauth?.accessToken;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}
async function refreshUsage() {
  const token = readAccessToken();
  let resp = "";
  if (token) {
    try {
      const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(3000)
      });
      const body = await r.json();
      if (body && typeof body === "object" && "five_hour" in body)
        resp = JSON.stringify(body);
    } catch {}
  }
  const now = Math.floor(Date.now() / 1000);
  if (resp) {
    writeAtomic(USAGE_CACHE_PATH, `${now}
${now + CACHE_TTL_DEFAULT}
${resp}
`);
    return;
  }
  const { dataTimestamp, cachedData } = readUsageCache();
  if (cachedData)
    writeAtomic(USAGE_CACHE_PATH, `${dataTimestamp}
${now + FETCH_BACKOFF}
${cachedData}
`);
}
async function refreshVersion() {
  try {
    const r = await fetch("https://api.github.com/repos/moreih29/claude-nexus/releases/latest", {
      headers: { "User-Agent": "claude-nexus-statusline", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(3000)
    });
    const tag = (await r.json())?.tag_name;
    if (typeof tag === "string" && tag) {
      writeAtomic(VERSION_CACHE_PATH, `${Math.floor(Date.now() / 1000)}
${tag.replace(/^v/, "")}
`);
    }
  } catch {}
}
function spawnRefresh(kind) {
  try {
    const child = spawn(process.execPath, [SCRIPT_PATH, "--refresh", kind], {
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
function readUsage() {
  const now = Math.floor(Date.now() / 1000);
  let { dataTimestamp, nextFetchAfter, cachedData } = readUsageCache();
  const age = () => dataTimestamp > 0 ? now - dataTimestamp : 0;
  if (cachedData && now < nextFetchAfter) {
    return { json: cachedData, stale: age() >= STALE_THRESHOLD, ageSeconds: age() };
  }
  if (cachedData) {
    writeAtomic(USAGE_CACHE_PATH, `${dataTimestamp}
${now + CACHE_TTL_DEFAULT}
${cachedData}
`);
    spawnRefresh("usage");
    return { json: cachedData, stale: age() >= STALE_THRESHOLD, ageSeconds: age() };
  }
  try {
    spawnSync(process.execPath, [SCRIPT_PATH, "--refresh", "usage"], { stdio: "ignore", timeout: 5000, windowsHide: true });
  } catch {}
  ({ dataTimestamp, cachedData } = readUsageCache());
  if (cachedData)
    return { json: cachedData, stale: false, ageSeconds: 0 };
  return null;
}
function utilPct(parsed, section) {
  if (!parsed)
    return 0;
  const data = parsed[section];
  return Number(data?.utilization) || 0;
}
function resetRemain(parsed, section) {
  const empty = { remaining: "", remainingCoarse: "" };
  if (!parsed)
    return empty;
  const data = parsed[section];
  const resetAt = data?.resets_at;
  if (!resetAt)
    return empty;
  try {
    const d = new Date(resetAt);
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0)
      return empty;
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
function isApiMode() {
  return !!process.env.ANTHROPIC_API_KEY;
}
var COST_CACHE_PATH = join(CLAUDE_CONFIG_DIR, ".api_cost_cache");
var COST_CACHE_TTL = 60;
var COST_STALE_THRESHOLD = 300;
function priceFor(model) {
  const m = model.toLowerCase();
  const TABLE = [
    [/opus-4-[5-9]/, 5, 25],
    [/opus-(?:4-[01]|4)(?:[-_]|$)/, 15, 75],
    [/opus-3/, 15, 75],
    [/sonnet-4(?:-\d+)?(?:[-_]|$)|4-sonnet/, 3, 15],
    [/sonnet-3-7|3-7-sonnet/, 3, 15],
    [/sonnet-3-5|3-5-sonnet/, 3, 15],
    [/haiku-4-5/, 1, 5],
    [/haiku-3-5|3-5-haiku/, 0.8, 4],
    [/haiku-3/, 0.25, 1.25]
  ];
  for (const [re, inp, out] of TABLE) {
    if (re.test(m)) {
      const inputPerToken = inp / 1e6;
      return {
        input: inputPerToken,
        output: out / 1e6,
        cache5m: inputPerToken * 1.25,
        cache1h: inputPerToken * 2,
        cacheRead: inputPerToken * 0.1
      };
    }
  }
  return null;
}
function turnCostUsd(model, usage) {
  const rates = priceFor(model);
  if (!rates)
    return 0;
  const inp = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
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
function scanLocalCostUsd() {
  const projectsRoot = join(CLAUDE_CONFIG_DIR, "projects");
  if (!existsSync(projectsRoot))
    return null;
  const todayStart = new Date;
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  let total = 0;
  let projectDirs;
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const proj of projectDirs) {
    const projPath = join(projectsRoot, proj);
    let entries;
    try {
      entries = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl"))
        continue;
      const fp = join(projPath, file);
      try {
        const st = statSync(fp);
        if (st.mtimeMs < todayStartMs)
          continue;
      } catch {
        continue;
      }
      let raw;
      try {
        raw = readFileSync(fp, "utf-8");
      } catch {
        continue;
      }
      const lines = raw.split(`
`);
      for (const line of lines) {
        if (!line || !line.includes('"assistant"'))
          continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== "assistant")
          continue;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < todayStartMs)
          continue;
        const model = entry.message?.model;
        const usage = entry.message?.usage;
        if (!model || !usage)
          continue;
        total += turnCostUsd(model, usage);
      }
    }
  }
  return total;
}
function readApiCost() {
  const now = Math.floor(Date.now() / 1000);
  let dataTimestamp = 0;
  let nextRescanAfter = 0;
  let cachedValue = "";
  if (existsSync(COST_CACHE_PATH)) {
    try {
      const lines = readFileSync(COST_CACHE_PATH, "utf-8").split(`
`);
      dataTimestamp = parseInt(lines[0]) || 0;
      nextRescanAfter = parseInt(lines[1]) || 0;
      cachedValue = (lines[2] || "").trim();
    } catch {}
  }
  const age = dataTimestamp > 0 ? now - dataTimestamp : 0;
  const parseCached = () => {
    if (!cachedValue)
      return null;
    const n = parseFloat(cachedValue);
    return Number.isFinite(n) ? n : null;
  };
  if (cachedValue && now < nextRescanAfter) {
    return { cost: parseCached(), stale: age >= COST_STALE_THRESHOLD, ageSeconds: age };
  }
  const cost = scanLocalCostUsd();
  if (cost === null) {
    return { cost: null, stale: false, ageSeconds: 0 };
  }
  writeAtomic(COST_CACHE_PATH, `${now}
${now + COST_CACHE_TTL}
${cost}`);
  return { cost, stale: false, ageSeconds: 0 };
}
function buildLine2() {
  const BAR_WIDTH = 6;
  const ctxPct = Math.round(getNum("used_percentage"));
  const ctx = meter("ctx", ctxPct, BAR_WIDTH);
  if (isApiMode()) {
    const { cost, stale, ageSeconds } = readApiCost();
    if (cost !== null) {
      let stalePart2 = "";
      if (stale) {
        const ageMin = Math.floor(ageSeconds / 60);
        const hh = Math.floor(ageMin / 60);
        const mm = ageMin % 60;
        const ageStr = hh > 0 ? `${hh}h${mm}m` : `${mm}m`;
        stalePart2 = ` ${SEP} \x1B[33m${ageStr} ago\x1B[0m`;
      }
      return `${ctx} ${SEP} ${DIM}API${RESET} ${pctColor(0)}$${cost.toFixed(2)} today${RESET}${stalePart2}`;
    }
    return `${ctx} ${SEP} ${DIM}API mode${RESET}`;
  }
  const noData = (label) => `${DIM}${label} ${"░".repeat(BAR_WIDTH)} --%${RESET}`;
  const usage = readUsage();
  if (!usage || !usage.json) {
    return `${ctx} ${SEP} ${noData("5h")} ${SEP} ${noData("7d")}`;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(usage.json);
  } catch {}
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
    stalePart = ` ${SEP} \x1B[33m${ageStr} ago\x1B[0m`;
  }
  return `${ctx} ${SEP} ${m5h}${tag5h} ${SEP} ${m7d}${tag7d}${stalePart}`;
}
function main() {
  process.stdout.write(buildLine1() + `
` + buildLine2() + `
`);
}
var refreshKind = process.argv[2] === "--refresh" ? process.argv[3] : "";
if (refreshKind === "usage" || refreshKind === "version") {
  (refreshKind === "usage" ? refreshUsage() : refreshVersion()).finally(() => process.exit(0));
} else {
  try {
    main();
  } catch {
    process.stdout.write(`nexus
`);
  }
}
