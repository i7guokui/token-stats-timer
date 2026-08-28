// run-token-stats / token-stats 模块
// =============================================================================
// 由 @liziy/token-stats 1.3.3 移植而来，与 @carlosgtrz/pi-run-timer 合并为一个插件。
// Footer 实时显示：run 计时 + 输入/输出/总量 + 缓存命中率 + 输出速率 + 上下文占用
// + 5h/周 套餐剩余（MiniMax / GLM / Kimi / DeepSeek / OpenCode Go / Command Code 内置套餐）
// 每轮对话自动落 JSONL，/stats 命令按日/小时/周/月查询
//
// 配置持久化：~/.pi/agent/extensions/token-stats/（与原包兼容，历史配置直接生效）
// 日志输出：  ~/.pi/agent/extensions/token-stats-logs/（与原包兼容，历史数据直接可用）

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown } from "@earendil-works/pi-tui";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { t } from "./user-language.ts";

// ── 共享状态（由 index.ts 注入，footer 渲染与模块解耦）──

export interface SharedState {
  /** session 存活标志：session_shutdown 置 false，session_start 置 true */
  sessionActive: boolean;
  /** 由 footer 注册的渲染请求函数；footer 销毁或 session 关闭时置 null */
  requestRender: (() => void) | null;
  /** 单次 run（agent_start → agent_settled）的 token 统计读取器；由 createTokenStats 注入 */
  getRunStats?: () => RunTokenStats | null;
}

/** 一次 run 的 token 汇总（供 step-timer 汇总条目使用，格式对齐 footer） */
export interface RunTokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  /** 平均输出速率（output / run 总耗时，t/s） */
  tokensPerSec: number;
  /** 缓存命中率（%，cacheRead / prompt 总量） */
  cacheHitRate: number;
  /** run 内是否至少完成一次 message_end */
  hasData: boolean;
}

// ── 路径 ──────────────────────────────────────────────────

const LOGS_DIR = join(homedir(), ".pi/agent/extensions/token-stats-logs");
const RAW_DIR = join(LOGS_DIR, "raw");
const HOURLY_DIR = join(LOGS_DIR, "hourly");
const DAILY_FILE = join(LOGS_DIR, "daily", "daily.jsonl");

const TOKEN_CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const TOKEN_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "config.json");
const QUOTA_CACHE_FILE = join(LOGS_DIR, "quota-cache.json");
const DISPLAY_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "display-config.json");

// ── 常量 ──────────────────────────────────────────────────

/** Rolling window 时长（毫秒），用于实时速率计算 */
const LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS = 2000;

/** 速率合理范围上限 */
const MAX_REASONABLE_TOKEN_SPEED = 1000;

// ── 类型 ──────────────────────────────────────────────────

interface TurnStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokensPerSec: number;
  cacheHitRate: number;
  model: string;
  firstTokenLatency: number; // 首 token 延迟（毫秒）
  wordCount: number;         // 输出词数（中日韩按字 + 其他按词）
  cost: number;              // 本轮花费（美元）
  liveTokenSpeed: number | null; // 流式 rolling window 速率
}

interface RawRecord extends TurnStats {
  ts: string;
  session: string;
}

interface HourlyRecord {
  date: string;
  hour: number;
  count: number;
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  sumTokensPerSec: number;
  avgCacheHitRate: number;
}

interface DailyRecord {
  date: string;
  count: number;
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  sumTokensPerSec: number;
  avgCacheHitRate: number;
}

// ── 套餐用量类型 ──────────────────────────────────────────

/** GLM / 智谱团队套餐凭证：组织 ID + 项目 ID（二者齐全才走团队查询） */
interface TeamCredential {
  organization: string;
  project: string;
}

/** fetchQuota 额外参数（目前仅 GLM 团队版使用） */
interface QuotaFetchExtra {
  team?: TeamCredential | null;
}

interface TokenPlan {
  id: string;
  name: string;
  matchProviders: string[];
  apiKeyEnv: string;
  baseUrl: string;
  quotaPath: string;
  authHeader: (key: string) => Record<string, string>;
  fetchQuota: (plan: TokenPlan, key: string, extra?: QuotaFetchExtra) => Promise<any>;
  format: (data: any) => { modelPrefix: string; display: string; color: 'ok' | 'warn' | 'err' };
}

interface TokenConfig {
  providerPlans: Record<string, string | null>;
  /** GLM 团队套餐凭证（可选），经 /stats 菜单配置并持久化 */
  teamCredential?: { organization: string; project: string };
  ttl: number;
}

interface QuotaCache {
  [planId: string]: {
    fetchedAt: number;
    ttl: number;
    data: any;
  };
}

export type ContextStyle = "pct-window" | "used-window" | "pct" | "used" | "bar";
export type SpeedStyle = "t/s" | "tok/s" | "T/s" | "liveAt";

export type DisplayKey =
  | "input"       // 输入（累计输入数 ↑）
  | "output"      // 输出（累计输出数 ↓）
  | "totalTokens" // 总token（累计输入+输出）
  | "cacheHit"    // 缓存命中率
  | "speed"       // 速度（tok/s）
  | "context"     // 容量（ctx%）
  | "quota5h"     // 5h 额度
  | "quotaWeek"   // 周额度
  | "quotaMonth"  // 月额度（OpenCode Go 等）
  | "quotaClock"  // 刷新时间（⏱）

export interface DisplayConfig {
  items: Record<DisplayKey, boolean>;
  contextStyle: ContextStyle;
  speedStyle: SpeedStyle;
}

// ── 状态 ──────────────────────────────────────────────────

interface LiveTokenSample {
  timestampMs: number;
  tokens: number;
}

// ── 套餐用量状态 ─────────────────────────────────────────

interface QuotaDisplayState {
  planId: string;
  display: string;
  modelPrefix: string;
  color: "ok" | "warn" | "err" | "muted";
  /** 该 state 对应的 provider；与当前 ctx.model.provider 不一致时视为残留 */
  provider: string;
  /** 数据获取时间戳；用于调试与新陈度判断 */
  fetchedAt: number;
  /** 错误时携带具体原因（key 缺失 / API 错误 / 网络错误 / 无数据） */
  error?: QuotaError;
}

type QuotaError =
  | { kind: "no_plan" }
  | { kind: "key_missing"; envVar: string; provider: string }
  | { kind: "api_error"; message: string }
  | { kind: "network_error"; message: string }
  | { kind: "no_data" };

// ── 工具函数 ──────────────────────────────────────────────

/**
 * Token 格式化（对齐 @firstpick/pi-utils formatTokens）
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toFixed(1);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatTokenSpeed(tokensPerSecond: number): string {
  if (tokensPerSecond < 100) {
    if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
    return tokensPerSecond.toFixed(2);
  }
  if (tokensPerSecond < 1000) return Math.round(tokensPerSecond).toString();
  if (tokensPerSecond < 10000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
  if (tokensPerSecond < 1000000) return `${Math.round(tokensPerSecond / 1000)}k`;
  if (tokensPerSecond < 10000000) return `${(tokensPerSecond / 1000000).toFixed(1)}M`;
  return `${Math.round(tokensPerSecond / 1000000)}M`;
}

/**
 * 生成 GitHub 风格 markdown 表格源码（由 Markdown 组件负责渲染对齐/换行）。
 *
 * @param headers 表头
 * @param rows    数据行
 * @param opts.aligns   每列对齐方式，缺省左对齐
 * @param opts.totalRow 底部合计行
 */
function renderTable(
  headers: string[],
  rows: string[][],
  opts?: {
    aligns?: Array<"left" | "right" | "center">;
    totalRow?: string[];
  },
): string[] {
  const aligns = opts?.aligns ?? [];
  // 转义单元格内的 | 与换行，防止破坏表格结构
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const alignMark = (i: number) => {
    const a = aligns[i] ?? "left";
    return a === "right" ? "---:" : a === "center" ? ":---:" : "---";
  };

  const lines = [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${headers.map((_, i) => alignMark(i)).join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ];
  if (opts?.totalRow) {
    lines.push(`| ${opts.totalRow.map(esc).join(" | ")} |`);
  }
  return lines;
}

// ── 按模型统计（读取 raw 明细，按 model 聚合）────────────────────

/** 读取若干日期的原始逐条记录 */
async function readRawRecordsForDates(dates: string[]): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for (const d of dates) {
    try {
      const content = await readFile(join(RAW_DIR, `${d}.jsonl`), "utf-8");
      for (const line of content.trim().split("\n")) {
        if (line) out.push(JSON.parse(line));
      }
    } catch {
      // 该日无原始数据
    }
  }
  return out;
}

/** 读取 [startDate, endDate] 闭区间内所有日期的原始记录 */
async function readRawRecordsInRange(
  startDate: string,
  endDate: string,
): Promise<RawRecord[]> {
  const dates: string[] = [];
  try {
    const files = await readdir(RAW_DIR);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const d = f.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= startDate && d <= endDate) {
        dates.push(d);
      }
    }
  } catch {
    // RAW_DIR 不存在
  }
  return readRawRecordsForDates(dates);
}

interface ModelAgg {
  count: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  tokensPerSecSum: number;
  hitRateSum: number;
}

/** 按模型生成 markdown 用量表（模型行按总token降序，末尾合计） */
function renderModelBreakdown(records: RawRecord[]): string[] {
  if (records.length === 0) return ["", t("> 按模型：该范围暂无明细数据", "> By model: no detail data in this range")];

  const byModel = new Map<string, ModelAgg>();
  for (const r of records) {
    const key = r.model || "unknown";
    const agg = byModel.get(key) ?? {
      count: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      tokensPerSecSum: 0,
      hitRateSum: 0,
    };
    agg.count++;
    agg.input += r.input;
    agg.cacheRead += r.cacheRead;
    agg.cacheWrite += r.cacheWrite;
    agg.output += r.output;
    agg.tokensPerSecSum += r.tokensPerSec;
    agg.hitRateSum += r.cacheHitRate;
    byModel.set(key, agg);
  }

  // 与汇总口径一致：总token = 新增输入 + 缓存输入
  const totalTokensOf = (a: ModelAgg) => a.input + a.cacheRead + a.cacheWrite;
  const rows = [...byModel.entries()].sort(
    (a, b) => totalTokensOf(b[1]) - totalTokensOf(a[1]),
  );

  const total: ModelAgg = {
    count: 0, input: 0, cacheRead: 0, cacheWrite: 0,
    output: 0, tokensPerSecSum: 0, hitRateSum: 0,
  };
  const body: string[][] = rows.map(([model, agg]) => {
    total.count += agg.count;
    total.input += agg.input;
    total.cacheRead += agg.cacheRead;
    total.cacheWrite += agg.cacheWrite;
    total.output += agg.output;
    total.tokensPerSecSum += agg.tokensPerSecSum;
    total.hitRateSum += agg.hitRateSum;
    return [
      model,
      String(agg.count),
      formatTokens(agg.input),
      formatTokens(agg.cacheRead),
      formatTokens(agg.output),
      formatTokens(totalTokensOf(agg)),
      `${(agg.count > 0 ? agg.hitRateSum / agg.count : 0).toFixed(1)}%`,
      `${(agg.count > 0 ? agg.tokensPerSecSum / agg.count : 0).toFixed(1)}`,
    ];
  });

  return [
    "",
    "**" + t("按模型", "By model") + "**",
    ...renderTable(
      [t("模型", "Model"), t("次数", "Count"), t("新增输入", "New input"), t("缓存输入", "Cached input"), t("输出", "Output"), t("总token", "Total tokens"), t("命中率", "Hit rate"), t("速率", "Speed")],
      body,
      {
        aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
        totalRow: [
          t("合计", "Total"),
          String(total.count),
          formatTokens(total.input),
          formatTokens(total.cacheRead),
          formatTokens(total.output),
          formatTokens(total.input + total.cacheRead + total.cacheWrite),
          `${(total.count > 0 ? total.hitRateSum / total.count : 0).toFixed(1)}%`,
          `${(total.count > 0 ? total.tokensPerSecSum / total.count : 0).toFixed(1)}`,
        ],
      },
    ),
  ];
}

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= MAX_REASONABLE_TOKEN_SPEED;
}

function estimateTokens(textLen: number): number {
  return Math.round(textLen / 4);
}

/**
 * 提取消息中的纯文本（含 thinking）
 */
function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const b = block as any;
    if (b?.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b?.type === "thinking" && typeof b.thinking === "string") {
      text += b.thinking;
    }
  }
  return text;
}

/**
 * 词数统计（CJK 按字 + 其他按词）
 * 参考 ChatBox 的 countWord 实现
 */
function countWords(text: string): number {
  if (!text) return 0;
  const pattern =
    /[a-zA-Z0-9_\u0392-\u03c9\u00c0-\u00ff\u0600-\u06ff\u0400-\u04ff]+|[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\uac00-\ud7af]+/g;
  const m = text.match(pattern);
  if (!m) return 0;
  let count = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i].charCodeAt(0) >= 0x4e00) {
      count += m[i].length;
    } else {
      count += 1;
    }
  }
  return count;
}

function getDateStr(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function getHour(ts = Date.now()): number {
  return new Date(ts).getHours();
}

function getISO(ts = Date.now()): string {
  return new Date(ts).toISOString();
}

export function formatUserPath(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

// ── 内置套餐定义 ─────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms >= 24 * 60 * 60 * 1000) {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days >= 7) return `${Math.floor(days / 7)}w ${days % 7}d`;
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTokenPlanDisplay(intervalRemaining: number, weeklyRemaining: number, nearestResetMs?: number | null): string {
  let display = `5h: ${Math.round(intervalRemaining)}% W: ${Math.round(weeklyRemaining)}%`;
  if (nearestResetMs && nearestResetMs > 0) {
    const diff = nearestResetMs - Date.now();
    if (diff > 0 && diff < 30 * 24 * 60 * 60 * 1000) {
      display += ` ⏱ ${formatDuration(diff)}`;
    }
  }
  return display;
}

const BUILTIN_PLANS: TokenPlan[] = [
  {
    id: "minimax",
    name: "MiniMax",
    matchProviders: ["minimax_local", "minimax-cn", "minimax"],
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimaxi.com",
    quotaPath: "/v1/api/openplatform/coding_plan/remains",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const url = "https://api.minimaxi.com" + plan.quotaPath;
      const r = await fetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      const data = await r.json();
      if (data.base_resp?.status_code === 0) return data;
      throw new Error(data.base_resp?.status_msg || t("MiniMax 返回错误", "MiniMax returned an error"));
    },
    format: (data: any) => {
      const models = data.model_remains || [];
      // MiniMax 官方接口 2026-07 起 model_name 改为 general / video 等语义化命名，
      // 不再是 MiniMax-M2 / MiniMax-M3。
      // 优先取 "general"（通用文本/编码套餐），否则取第一项
      const m =
        models.find((x: any) => x.model_name === "general") ||
        models.find((x: any) => x.model_name?.includes("M2")) ||
        models[0];
      if (!m) return { modelPrefix: "", display: "无数据", color: "err" as const };
      const intervalRemaining = m.current_interval_remaining_percent ?? 0;
      const weeklyRemaining = m.current_weekly_remaining_percent ?? 0;
      const now = Date.now();
      const resets = [m.end_time, m.weekly_end_time].filter((t: any) => typeof t === "number" && t > now);
      const nearestReset = resets.length > 0 ? Math.min(...resets) : null;
      return {
        modelPrefix: "",
        display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset),
        color: intervalRemaining < 20 || weeklyRemaining < 20 ? "err" as const : intervalRemaining < 50 || weeklyRemaining < 50 ? "warn" as const : "ok" as const,
      };
    },
  },
  {
    id: "glm",
    name: "GLM (智谱)",
    matchProviders: ["zhipu-cn", "zhipu", "glm", "bigmodel", "zai-coding-cn"],
    apiKeyEnv: "GLM_API_KEY",
    baseUrl: "https://open.bigmodel.cn",
    quotaPath: "/api/monitor/usage/quota/limit",
    authHeader: (key) => ({ Authorization: key }),
    fetchQuota: async (plan: TokenPlan, key: string, extra?: QuotaFetchExtra) => {
      const team = extra?.team;
      const headers: Record<string, string> = {
        ...plan.authHeader(key),
        "Content-Type": "application/json",
      };
      // 团队套餐：同一 quota 端点加 ?type=2，并携带组织/项目 ID 请求头
      // （api_key + 组织 ID + 项目 ID 三者缺一不可，仅国内站 open.bigmodel.cn 有团队版）
      if (team) {
        headers["Bigmodel-Organization"] = team.organization;
        headers["Bigmodel-Project"] = team.project;
      }
      const url = plan.baseUrl + plan.quotaPath + (team ? "?type=2" : "");
      const r = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(t("GLM 配额查询 HTTP " + r.status, "GLM quota query HTTP " + r.status));
      return await r.json();
    },
    format: (data: any) => {
      const limits = data?.data?.limits || [];
      // 个人版返回 TOKENS_LIMIT，团队版返回 CREDIT_LIMIT（大小写不敏感）必识
      const isQuota = (t: any) => {
        const s = String(t ?? "").toLowerCase();
        return s === "tokens_limit" || s === "credit_limit";
      };
      const entries = limits.filter((x: any) => isQuota(x?.type));
      if (entries.length === 0) return { modelPrefix: "", display: "无数据", color: "err" as const };

      // 窗口分类锚定 unit（不依赖数组顺序，与 cc-switch parse_zhipu_token_tiers 一致）：
      //   unit: 3 → 5h 滚动窗口；unit: 6 → 每周窗口（老/新套餐 number 7 / 1 均可能）
      const byUnit = (u: number) => entries.find((x: any) => x?.unit === u);
      let fiveHour: any = byUnit(3) ?? null;
      let weekly: any = byUnit(6) ?? null;
      // 兜底：unit 缺失/不识别 → 无 nextResetTime 优先归 5h，其余按重置时间升序补槽
      if (!fiveHour || !weekly) {
        const unclassified = entries
          .filter((x: any) => x !== fiveHour && x !== weekly)
          .sort((a: any, b: any) =>
            (typeof a?.nextResetTime === "number" ? a.nextResetTime : Number.MIN_SAFE_INTEGER) -
            (typeof b?.nextResetTime === "number" ? b.nextResetTime : Number.MIN_SAFE_INTEGER));
        for (const e of unclassified) {
          if (!fiveHour) fiveHour = e;
          else if (!weekly) weekly = e;
        }
      }

      // percentage 为已用比例 → 剩余 = 100 - 已用
      const intervalRemaining = fiveHour ? 100 - (fiveHour.percentage ?? 0) : null;
      const weeklyRemaining = weekly ? 100 - (weekly.percentage ?? 0) : null;
      const now = Date.now();
      const resets = entries
        .map((x: any) => x?.nextResetTime)
        .filter((t: any) => typeof t === "number" && t > now);
      const nearestReset = resets.length > 0 ? Math.min(...resets) : null;

      const both = intervalRemaining !== null && weeklyRemaining !== null;
      const display =
        intervalRemaining !== null && weeklyRemaining !== null
          ? formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset)
          : intervalRemaining !== null
            ? `5h: ${Math.round(intervalRemaining)}%`
            : weeklyRemaining !== null
              ? `W: ${Math.round(weeklyRemaining)}%`
              : "无数据";
      const low = (v: number | null) => v !== null && v < 20;
      const mid = (v: number | null) => v !== null && v < 50;
      const color = low(intervalRemaining) || low(weeklyRemaining) ? "err" as const
        : mid(intervalRemaining) || mid(weeklyRemaining) ? "warn" as const
          : "ok" as const;
      return { modelPrefix: "", display, color };
    },
  },
  {
    id: "kimi",
    name: "Kimi",
    matchProviders: ["moonshot-cn", "moonshot", "kimi"],
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.kimi.com",
    quotaPath: "/coding/v1/usages",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const r = await fetch(plan.baseUrl + plan.quotaPath, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(t("Kimi 配额查询 HTTP " + r.status, "Kimi quota query HTTP " + r.status));
      return await r.json();
    },
    format: (data: any) => {
      const limits = data.limits || [];
      let intervalRemaining = 100;
      let nearestReset: number | null = null;
      if (limits.length > 0) {
        const d = limits[0].detail || {};
        const limit = d.limit || 1;
        const remaining = Math.max(d.remaining ?? 0, 0);
        intervalRemaining = (remaining / limit) * 100;
        const rt = d.resetTime;
        if (rt) {
          const ms = typeof rt === "string" ? new Date(rt).getTime() : rt;
          if (ms > Date.now()) nearestReset = ms;
        }
      }
      const usage = data.usage || {};
      let weeklyRemaining = 100;
      if (usage.limit) {
        const remaining = Math.max(usage.remaining ?? 0, 0);
        weeklyRemaining = (remaining / usage.limit) * 100;
        const rt = usage.resetTime;
        if (rt) {
          const ms = typeof rt === "string" ? new Date(rt).getTime() : rt;
          if (nearestReset === null || ms < nearestReset) nearestReset = ms;
        }
      }
      if (intervalRemaining >= 100 && weeklyRemaining >= 100) return { modelPrefix: "", display: "无数据", color: "err" as const };
      return {
        modelPrefix: "",
        display: formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset),
        color: intervalRemaining < 20 || weeklyRemaining < 20 ? "err" as const : intervalRemaining < 50 || weeklyRemaining < 50 ? "warn" as const : "ok" as const,
      };
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    matchProviders: ["deepseek-cn", "deepseek"],
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    quotaPath: "/user/balance",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const r = await fetch(plan.baseUrl + plan.quotaPath, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(t("DeepSeek 配额查询 HTTP " + r.status, "DeepSeek quota query HTTP " + r.status));
      return await r.json();
    },
    format: (data: any) => {
      const infos = data?.balance_infos || [];
      const cny = infos.find((x: any) => x.currency === "CNY") || infos[0];
      if (!cny) return { modelPrefix: "", display: "无数据", color: "err" as const };
      const total = parseFloat(cny.total_balance || "0");
      return {
        modelPrefix: "",
        display: "¥" + total.toFixed(1),
        color: total < 1 ? "warn" as const : "ok" as const,
      };
    },
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    matchProviders: ["opencode-go"],
    apiKeyEnv: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai",
    quotaPath: "/zen/go/v1/usage",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      const r = await fetch(plan.baseUrl + plan.quotaPath, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(t("OpenCode Go 配额查询 HTTP " + r.status, "OpenCode Go quota query HTTP " + r.status));
      return await r.json();
    },
    format: (data: any) => {
      // 官方 /v1/usage：percent 为已用比例，remaining = 100 - percent
      const u = (data && typeof data === "object" ? (data.usage ?? data) : {}) as any;
      const win = (k: string): any => {
        const w = u?.[k];
        if (w && w.status === "ok" && typeof w.percent === "number") return w;
        return null;
      };
      const rolling = win("rolling");
      const weekly = win("weekly");
      const monthly = win("monthly");
      if (!rolling && !weekly && !monthly) {
        return { modelPrefix: "", display: "无数据", color: "err" as const };
      }
      const now = Date.now();
      const resets = [rolling, weekly, monthly]
        .filter((w): w is any => !!w)
        .map((w) => {
          const t = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : NaN;
          return Number.isFinite(t) && t > now ? t : null;
        })
        .filter((t): t is number => t !== null);
      const nearestReset = resets.length > 0 ? Math.min(...resets) : null;

      const rem = (w: any) => (w ? 100 - w.percent : null);
      const r = rem(rolling);
      const wk = rem(weekly);
      const mo = rem(monthly);
      const parts: string[] = [];
      if (r !== null) parts.push(`5h: ${Math.round(r)}%`);
      if (wk !== null) parts.push(`W: ${Math.round(wk)}%`);
      if (mo !== null) parts.push(`M: ${Math.round(mo)}%`);
      let display = parts.join(" ");
      if (nearestReset) {
        const diff = nearestReset - now;
        if (diff > 0 && diff < 30 * 24 * 60 * 60 * 1000) {
          display += ` ⏱ ${formatDuration(diff)}`;
        }
      }
      const low = (v: number | null) => v !== null && v < 20;
      const mid = (v: number | null) => v !== null && v < 50;
      const color = low(r) || low(wk) || low(mo) ? "err" as const
        : mid(r) || mid(wk) || mid(mo) ? "warn" as const
          : "ok" as const;
      return { modelPrefix: "", display, color };
    },
  },
  {
    id: "commandcode",
    name: "Command Code",
    // pi 内 commandcode provider：auth.json 里 key 为 user_...；models.json 的 provider id 可能是 cmd 或 commandcode
    matchProviders: ["cmd", "commandcode"],
    apiKeyEnv: "COMMANDCODE_API_KEY",
    baseUrl: "https://api.commandcode.ai",
    quotaPath: "/alpha/billing/credits",
    authHeader: (key) => ({ Authorization: "Bearer " + key }),
    fetchQuota: async (plan: TokenPlan, key: string) => {
      // Command Code 官方 alpha 计费接口（与官方 CLI 同款协议）：
      //   GET /alpha/whoami        → 用户信息，org.id 非空时后续请求带 ?orgId=xxx
      //   GET /alpha/billing/credits → { credits, windowLimits: { fiveHour, weekly } }
      //   GET /alpha/billing/subscriptions → { success, data: { planId, currentPeriodEnd } }
      // 需要 User-Agent / x-command-code-version 头（与 command-code CLI 一致），否则部分接口 403。
      const headers: Record<string, string> = {
        ...plan.authHeader(key),
        "Content-Type": "application/json",
        "User-Agent": "command-code/0.38.2",
        "x-command-code-version": "0.38.2",
      };
      const whoami = await fetch(plan.baseUrl + "/alpha/whoami", {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!whoami.ok) throw new Error(t("Command Code whoami 查询 HTTP " + whoami.status, "Command Code whoami query HTTP " + whoami.status));
      const whoamiData = await whoami.json();
      const orgId = whoamiData?.org?.id as string | undefined;
      const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

      const [creditsR, subR] = await Promise.all([
        fetch(plan.baseUrl + plan.quotaPath + qs, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(5000),
        }),
        fetch(plan.baseUrl + "/alpha/billing/subscriptions" + qs, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(5000),
        }).catch(() => null), // 订阅信息缺失时降级（仅影响月额度分母）
      ]);
      if (!creditsR.ok) throw new Error(t("Command Code 配额查询 HTTP " + creditsR.status, "Command Code quota query HTTP " + creditsR.status));
      const creditsData = await creditsR.json();
      let subData: any = null;
      if (subR && subR.ok) {
        try { subData = await subR.json(); } catch { /* ignore */ }
      }
      return { credits: creditsData, subscription: subData };
    },
    format: (data: any) => {
      const credits = data?.credits?.credits || {};
      const windows = data?.credits?.windowLimits || {};
      const fiveHour = windows.fiveHour;
      const weekly = windows.weekly;

      // 滚动窗口：used/cap 为美元金额，剩余 = (cap - used) / cap
      const remOf = (w: any): number | null => {
        if (!w || typeof w !== "object") return null;
        const cap = Number(w.cap);
        const used = Number(w.used ?? 0);
        if (!Number.isFinite(cap) || cap <= 0) return null;
        return Math.max(0, Math.min(100, ((cap - used) / cap) * 100));
      };
      const intervalRemaining = remOf(fiveHour);
      const weeklyRemaining = remOf(weekly);

      // 月额度：接口只报剩余（monthlyCredits），分母来自订阅 planId 的公开套餐目录
      // （5h/周 cap 与目录一致才信，防止套餐调价后算错百分比）
      const sub = data?.subscription?.data;
      const planId = String(sub?.planId || "").toLowerCase();
      const plan = COMMANDCODE_PLANS[planId as keyof typeof COMMANDCODE_PLANS];
      const monthlyRemaining = Number(credits.monthlyCredits ?? NaN);
      let monthlyPercent: number | null = null;
      if (
        plan &&
        Number.isFinite(monthlyRemaining) &&
        monthlyRemaining <= plan.monthlyCreditsUsd &&
        fiveHour?.cap !== undefined &&
        Number(fiveHour.cap) === plan.fiveHourCapUsd &&
        weekly?.cap !== undefined &&
        Number(weekly.cap) === plan.weeklyCapUsd
      ) {
        monthlyPercent = (monthlyRemaining / plan.monthlyCreditsUsd) * 100;
      }

      // 最近重置时间（5h / 周 / 月账单周期，取最早）
      // resetAt 秒级/毫秒级都可能是：>2e10 视为毫秒（当前毫秒时间戳 ~1.78e12），否则按秒处理
      const now = Date.now();
      const resets: number[] = [];
      for (const w of [fiveHour, weekly]) {
        const t = Number(w?.resetAt ?? 0);
        if (Number.isFinite(t) && t > 0) {
          const ms = t > 20000000000 ? t : t * 1000;
          if (ms > now) resets.push(ms);
        }
      }
      const periodEnd = sub?.currentPeriodEnd;
      if (periodEnd) {
        const ms = new Date(periodEnd).getTime();
        if (Number.isFinite(ms) && ms > now) resets.push(ms);
      }
      const nearestReset = resets.length > 0 ? Math.min(...resets) : null;

      const parts: string[] = [];
      if (intervalRemaining !== null) parts.push(`5h: ${Math.round(intervalRemaining)}%`);
      if (weeklyRemaining !== null) parts.push(`W: ${Math.round(weeklyRemaining)}%`);
      if (monthlyPercent !== null) parts.push(`M: ${Math.round(monthlyPercent)}%`);
      if (monthlyPercent === null && Number.isFinite(monthlyRemaining)) {
        parts.push(`$${monthlyRemaining.toFixed(0)}`); // 未知套餐：只显示剩余金额（美元）
      }
      let display = parts.join(" ");
      if (!display) display = "无数据";
      if (nearestReset) {
        const diff = nearestReset - now;
        if (diff > 0 && diff < 30 * 24 * 60 * 60 * 1000) {
          display += ` ⏱ ${formatDuration(diff)}`;
        }
      }
      const low = (v: number | null) => v !== null && v < 20;
      const mid = (v: number | null) => v !== null && v < 50;
      const color = low(intervalRemaining) || low(weeklyRemaining) || low(monthlyPercent) ? "err" as const
        : mid(intervalRemaining) || mid(weeklyRemaining) || mid(monthlyPercent) ? "warn" as const
          : "ok" as const;
      return { modelPrefix: "", display, color };
    },
  },
];

/**
 * Command Code 公开套餐目录（5h/周 cap 与月额度，来源 commandcode.ai 定价页）。
 * 月额度接口只返回剩余值，需按 planId 匹配此表拿到分母；cap 与接口返回值一致才采用。
 */
const COMMANDCODE_PLANS: Record<string, { label: string; monthlyCreditsUsd: number; fiveHourCapUsd: number; weeklyCapUsd: number }> = {
  "individual-go": { label: "Go", monthlyCreditsUsd: 10, fiveHourCapUsd: 3, weeklyCapUsd: 6 },
  "individual-goat": { label: "GOAT", monthlyCreditsUsd: 70, fiveHourCapUsd: 14, weeklyCapUsd: 35 },
  "individual-pro": { label: "Pro", monthlyCreditsUsd: 80, fiveHourCapUsd: 16, weeklyCapUsd: 40 },
  "individual-max": { label: "Max 10x", monthlyCreditsUsd: 150, fiveHourCapUsd: 45, weeklyCapUsd: 90 },
  "individual-ultra": { label: "Max 20x", monthlyCreditsUsd: 300, fiveHourCapUsd: 90, weeklyCapUsd: 180 },
};

const DEFAULT_TOKEN_CONFIG: TokenConfig = { providerPlans: {}, ttl: 60 };

const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  items: {
    input: true,
    output: true,
    totalTokens: false,
    cacheHit: true,
    speed: true,
    context: true,
    quota5h: true,
    quotaWeek: true,
    quotaMonth: true,
    quotaClock: true,
  },
  contextStyle: "pct-window",
  speedStyle: "t/s",
};

// ── 模块入口 ─────────────────────────────────────────────

export interface TokenStatsHandle {
  /** footer 上行指标段（不含 run 计时；计时由 index.ts 拼接） */
  getMetricParts(theme: Theme, ctx: ExtensionContext): string[];
}

export function createTokenStats(
  pi: ExtensionAPI,
  shared: SharedState,
): TokenStatsHandle {
  // ── 累计统计状态 ────────────────────────────────────

  const stats = {
    // 累计会话
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    turnCount: 0,
    // 本轮计时
    turnStartTime: 0,
    firstTokenTime: 0,
    streaming: false,
    // 缓存命中率累加（用于平均值）
    totalCacheHitRateSum: 0,
    // 本轮最终（message_end 时写入）
    lastInput: 0,
    lastOutput: 0,
    lastCacheRead: 0,
    lastCacheWrite: 0,
    lastCost: 0,
    lastCacheHitRate: 0,
    lastTokensPerSec: 0,           // 平均速率（output / elapsed）
    lastLiveTokenSpeed: null as number | null, // rolling window 速率
    lastFirstTokenLatency: 0,      // 首 token 延迟（毫秒）
    lastWordCount: 0,              // 输出词数
    // ── 流式 rolling window 状态 ─────────────────────────
    liveOutputChars: 0,
    liveEstimatedTokens: 0,
    liveUsageOutputTokens: 0,
    liveTokenSamples: [] as LiveTokenSample[],
    // ── 去重（防止 message_end + turn_end 重复累加）───
    accountedUsageKeys: new Set<string>(),
  };

  // ── 套餐用量状态 ────────────────────────────────────

  let quotaState: QuotaDisplayState | null = null;
  let quotaTimerId: ReturnType<typeof setInterval> | null = null;
  let tokenConfig: TokenConfig | null = null;
  let lastQuotaProvider: string | null = null;

  // ── run 级 token 累加（agent_start 重置，agent_settled 时供 step-timer 读取）──

  let runStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 0,
  };
  let runStartMs = 0;
  let runLastMsgMs = 0;

  function resetRunStats(): void {
    runStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    runStartMs = Date.now();
    runLastMsgMs = 0;
  }

  /** 读取当前 run 的 token 汇总（无数据返回 hasData=false） */
  function getRunStats(): RunTokenStats {
    if (runStats.turns === 0) {
      return { ...runStats, tokensPerSec: 0, cacheHitRate: 0, hasData: false };
    }
    const totalMs = runLastMsgMs - runStartMs;
    const tokensPerSec = totalMs >= 50 ? runStats.output / (totalMs / 1000) : 0;
    const totalPrompt = runStats.input + runStats.cacheRead + runStats.cacheWrite;
    const cacheHitRate = totalPrompt > 0 ? (runStats.cacheRead / totalPrompt) * 100 : 0;
    return { ...runStats, tokensPerSec, cacheHitRate, hasData: true };
  }

  shared.getRunStats = getRunStats;

  let displayConfig: DisplayConfig = {
    ...DEFAULT_DISPLAY_CONFIG,
    items: { ...DEFAULT_DISPLAY_CONFIG.items },
  };

  // ── UI 刷新 ──────────────────────────────────────────

  /** 等宽进度条：██░░░░░░ 25% */
  function progressBar(pct: number, width = 8): string {
    const filled = Math.round(Math.min(pct, 100) / 100 * width);
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
  }

  function getRollingLiveTokenSpeed(nowMs: number = Date.now()): number | null {
    const cutoffMs = nowMs - LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS;
    stats.liveTokenSamples = stats.liveTokenSamples.filter(
      (s) => s.timestampMs >= cutoffMs,
    );
    if (stats.liveTokenSamples.length === 0) return null;

    const firstSampleMs = stats.liveTokenSamples[0]!.timestampMs;
    const windowStartMs = Math.max(stats.turnStartTime || firstSampleMs, cutoffMs);
    const elapsedSeconds = (nowMs - windowStartMs) / 1000;
    if (elapsedSeconds <= 0) return null;

    const tokens = stats.liveTokenSamples.reduce((sum, s) => sum + s.tokens, 0);
    const speed = tokens / elapsedSeconds;
    return isReasonableTokenSpeed(speed) ? speed : null;
  }

  function resetLiveState() {
    stats.liveOutputChars = 0;
    stats.liveEstimatedTokens = 0;
    stats.liveUsageOutputTokens = 0;
    stats.liveTokenSamples = [];
  }

  function getMetricParts(theme: Theme, ctx: ExtensionContext): string[] {
    const dim = (s: string) => theme.fg("dim", s);
    const warn = (s: string) => theme.fg("warning", s);
    const ok = (s: string) => theme.fg("success", s);
    const muted = (s: string) => theme.fg("muted", s);

    const parts: string[] = [];
    const cfg = displayConfig.items;

    // ── 输入 / 输出 / 总token / 缓存命中 ──────────────
    {
      const segParts: string[] = [];
      if (cfg.input) segParts.push(`↑${formatTokens(stats.totalInput)}`);
      if (cfg.output) segParts.push(`↓${formatTokens(stats.totalOutput)}`);
      if (cfg.totalTokens) {
        const total = stats.totalInput + stats.totalOutput;
        segParts.push(`Σ${formatTokens(total)}`);
      }
      if (cfg.cacheHit) {
        const totalPrompt = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
        const cumCH = totalPrompt > 0 ? (stats.totalCacheRead / totalPrompt) * 100 : 0;
        const chColor = cumCH >= 80 ? ok
          : cumCH >= 50 ? (s: string) => s
          : warn;
        segParts.push(`${dim("CH")}${chColor(`${cumCH.toFixed(1)}%`)}`);
      }
      if (segParts.length > 0) parts.push(segParts.join(" "));
    }

    // ── 速度 ⚡ ─────────────────────────────────────────
    if (cfg.speed) {
      const liveSpeed = getRollingLiveTokenSpeed();
      const displaySpeed = liveSpeed !== null ? liveSpeed : stats.lastTokensPerSec;
      const speedNum = ok(formatTokenSpeed(displaySpeed));
      const speedStyle = displayConfig.speedStyle ?? "t/s";
      switch (speedStyle) {
        case "tok/s":
          parts.push(`⚡${speedNum} tok/s`);
          break;
        case "T/s":
          parts.push(`⚡${speedNum} T/s`);
          break;
        case "liveAt":
          if (stats.streaming && liveSpeed !== null) {
            parts.push(`⚡${formatTokens(stats.liveEstimatedTokens)}@${speedNum}`);
          } else {
            parts.push(`⚡${speedNum} t/s`);
          }
          break;
        default:
          parts.push(`⚡${speedNum} t/s`);
          break;
      }
    }

    // ── 容量 ────────────────────────────────────────────
    if (cfg.context) {
      try {
        const cu = ctx.getContextUsage();
        const ctxWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const ctxPercent = typeof cu?.percent === "number" ? cu.percent : null;
        const ctxUsed = ctxPercent !== null && ctxWindow > 0 ? Math.round(ctxWindow * ctxPercent / 100) : 0;
        const ctxStyle = displayConfig.contextStyle ?? "pct-window";
        let ctxStr: string;
        if (ctxWindow > 0 && ctxPercent !== null) {
          switch (ctxStyle) {
            case "used-window":
              ctxStr = `${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`;
              break;
            case "pct":
              ctxStr = `${ctxPercent.toFixed(1)}%`;
              break;
            case "used":
              ctxStr = formatTokens(ctxUsed);
              break;
            case "bar":
              ctxStr = `${progressBar(ctxPercent)} ${ctxPercent.toFixed(1)}%`;
              break;
            default:
              ctxStr = `${ctxPercent.toFixed(1)}%/${formatTokens(ctxWindow)}`;
              break;
          }
        } else {
          ctxStr = ctxWindow > 0 ? `?/${formatTokens(ctxWindow)}` : `0%/0`;
        }
        const ctxColor = ctxPercent !== null && ctxWindow > 0
          ? ctxPercent < 50 ? ok
            : ctxPercent < 65 ? (s: string) => theme.fg("accent", s)
              : ctxPercent < 75 ? muted
                : ctxPercent < 85 ? warn
                  : (s: string) => theme.fg("error", s)
          : dim;
        parts.push(ctxColor(ctxStr));
      } catch { /* ignore */ }
    }

    // ── 套餐用量（最右侧）：检测 provider 变化，自动隐藏/刷新 ─
    const curProvider = ctx.model?.provider ?? null;
    if (curProvider !== lastQuotaProvider) {
      // 跨 provider 切换：force refresh（绕过缓存）
      if (lastQuotaProvider !== null || curProvider !== null) {
        setTimeout(() => {
          if (!shared.sessionActive) return;
          refreshQuota(ctx, true)
            .then(() => shared.requestRender?.())
            .catch(() => { /* ctx 已失效（session 被替换），忽略 */ });
        }, 0);
      }
      lastQuotaProvider = curProvider;
    }
    if (quotaState && quotaState.display) {
      const qColor = quotaState.color === "ok" ? ok
        : quotaState.color === "warn" ? warn
          : quotaState.color === "err" ? (s: string) => theme.fg("error", s)
            : muted;
      const prefix = quotaState.modelPrefix ? quotaState.modelPrefix + " " : "";

      // error 状态（如 no_plan / key_missing）也显示具体原因，不再静默消失
      if (quotaState.error) {
        parts.push(qColor(prefix + quotaState.display));
      } else {
        // 正常状态：按子项过滤配额显示
        const fullDisplay = quotaState.display;
        const filteredParts: string[] = [];
        if (cfg.quota5h) {
          const m = fullDisplay.match(/\b5h:\s+\d+%/);
          if (m) filteredParts.push(m[0]);
        }
        if (cfg.quotaWeek) {
          const m = fullDisplay.match(/\bW:\s+\d+%/);
          if (m) filteredParts.push(m[0]);
        }
        if (cfg.quotaMonth) {
          const m = fullDisplay.match(/\bM:\s+\d+%/);
          if (m) filteredParts.push(m[0]);
        }
        if (cfg.quotaClock) {
          const m = fullDisplay.match(/⏱\s*\d+[hm]/);
          if (m) filteredParts.push(m[0]);
        }
        if (filteredParts.length > 0) {
          parts.push(qColor(prefix + filteredParts.join(" ")));
        }
      }
    }

    return parts;
  }

  // ── 日志持久化 ───────────────────────────────────────

  async function ensureDir(dir: string) {
    await mkdir(dir, { recursive: true });
  }

  async function appendRaw(record: RawRecord) {
    await ensureDir(RAW_DIR);
    const file = join(RAW_DIR, `${record.ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(record) + "\n", "utf-8");
  }

  async function updateHourly(record: RawRecord) {
    await ensureDir(HOURLY_DIR);
    const date = record.ts.slice(0, 10);
    const hour = new Date(record.ts).getHours();
    const file = join(HOURLY_DIR, `${date}.jsonl`);

    let lines: string[] = [];
    try {
      lines = (await readFile(file, "utf-8")).trim().split("\n").filter(Boolean);
    } catch {
      // 文件不存在
    }

    const records: HourlyRecord[] = lines.map((l) => JSON.parse(l));
    const idx = records.findIndex(
      (r) => r.date === date && r.hour === hour,
    );

    if (idx >= 0) {
      const r = records[idx];
      const newCount = r.count + 1;
      records[idx] = {
        date,
        hour,
        count: newCount,
        sumInput: r.sumInput + record.input,
        sumOutput: r.sumOutput + record.output,
        sumCacheRead: r.sumCacheRead + record.cacheRead,
        sumCacheWrite: r.sumCacheWrite + record.cacheWrite,
        sumTokensPerSec: r.sumTokensPerSec + record.tokensPerSec,
        avgCacheHitRate:
          ((r.avgCacheHitRate * r.count + record.cacheHitRate) / newCount),
      };
    } else {
      records.push({
        date,
        hour,
        count: 1,
        sumInput: record.input,
        sumOutput: record.output,
        sumCacheRead: record.cacheRead,
        sumCacheWrite: record.cacheWrite,
        sumTokensPerSec: record.tokensPerSec,
        avgCacheHitRate: record.cacheHitRate,
      });
    }

    await writeFile(
      file,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8",
    );
  }

  async function updateDaily(record: RawRecord) {
    await ensureDir(join(LOGS_DIR, "daily"));
    const date = record.ts.slice(0, 10);

    let lines: string[] = [];
    try {
      lines = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
        .filter(Boolean);
    } catch {
      // 文件不存在
    }

    const records: DailyRecord[] = lines.map((l) => JSON.parse(l));
    const idx = records.findIndex((r) => r.date === date);

    if (idx >= 0) {
      const r = records[idx];
      const newCount = r.count + 1;
      records[idx] = {
        date,
        count: newCount,
        sumInput: r.sumInput + record.input,
        sumOutput: r.sumOutput + record.output,
        sumCacheRead: r.sumCacheRead + record.cacheRead,
        sumCacheWrite: r.sumCacheWrite + record.cacheWrite,
        sumTokensPerSec: r.sumTokensPerSec + record.tokensPerSec,
        avgCacheHitRate:
          ((r.avgCacheHitRate * r.count + record.cacheHitRate) / newCount),
      };
    } else {
      records.push({
        date,
        count: 1,
        sumInput: record.input,
        sumOutput: record.output,
        sumCacheRead: record.cacheRead,
        sumCacheWrite: record.cacheWrite,
        sumTokensPerSec: record.tokensPerSec,
        avgCacheHitRate: record.cacheHitRate,
      });
    }

    await writeFile(
      DAILY_FILE,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8",
    );
  }

  async function persistTurn(record: TurnStats, sessionId: string) {
    const raw: RawRecord = {
      ...record,
      ts: getISO(),
      session: sessionId,
    };
    await appendRaw(raw);
    await updateHourly(raw);
    await updateDaily(raw);
  }

  // ── 会话恢复：从历史消息重建累计统计 ─────────────────

  function normalizeTimestampMs(timestamp: number): number {
    // 处理混合时间戳单位
    if (timestamp < 1e11) return timestamp * 1000;  // seconds → ms
    if (timestamp > 1e14) return Math.floor(timestamp / 1000); // microsec → ms
    return timestamp;
  }

  function getEntryTimestampMs(entry: {
    type: string;
    timestamp: string;
    message?: { timestamp?: number };
  }): number | null {
    if (entry.type === "message" && typeof entry.message?.timestamp === "number") {
      return normalizeTimestampMs(entry.message.timestamp);
    }
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function rebuildFromHistory(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    stats.totalInput = 0;
    stats.totalOutput = 0;
    stats.totalCacheRead = 0;
    stats.totalCacheWrite = 0;
    stats.totalCost = 0;
    stats.totalCacheHitRateSum = 0;
    stats.turnCount = 0;
    stats.accountedUsageKeys = new Set();
    stats.lastTokensPerSec = 0;

    // 遍历 entries 重建累计统计，同时推算历史速率
    let latestAssistantSpeed: number | null = null;

    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const msg = (entry as any).message;
      if (msg.role !== "assistant" || !msg.usage) continue;

      stats.totalInput += msg.usage.input ?? 0;
      stats.totalOutput += msg.usage.output ?? 0;
      stats.totalCacheRead += msg.usage.cacheRead ?? 0;
      stats.totalCacheWrite += msg.usage.cacheWrite ?? 0;
      stats.totalCost += msg.usage.cost?.total ?? 0;

      const promptTokens = (msg.usage.input ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0);
      const chRate = promptTokens > 0
        ? ((msg.usage.cacheRead ?? 0) / promptTokens) * 100
        : 0;
      stats.totalCacheHitRateSum += chRate;
      stats.turnCount++;

      // 推算历史速率：从上一个 user 消息到本条 assistant 的耗时
      if ((msg.usage.output ?? 0) <= 0) continue;
      const endMs = getEntryTimestampMs(entry);
      if (endMs === null) continue;

      for (let j = branch.indexOf(entry) - 1; j >= 0; j--) {
        const prev = branch[j];
        if (prev.type !== "message") continue;
        const prevMsg = (prev as any).message;
        if (prevMsg.role === "assistant") continue; // 跳过 assistant 之间的 delta

        const startMs = getEntryTimestampMs(prev);
        if (startMs === null || endMs <= startMs) continue;

        const elapsedSeconds = (endMs - startMs) / 1000;
        if (elapsedSeconds <= 0) continue;

        const speed = (msg.usage.output ?? 0) / elapsedSeconds;
        if (!isReasonableTokenSpeed(speed)) continue;

        if (prevMsg.role === "user") {
          latestAssistantSpeed = speed;
          break;
        }
        // 非 user 消息的 fallback
        if (latestAssistantSpeed === null) latestAssistantSpeed = speed;
      }
    }

    if (latestAssistantSpeed !== null) {
      stats.lastTokensPerSec = latestAssistantSpeed;
    }
  }

  // ── 配置文件操作 ─────────────────────────────────────

  async function loadTokenConfig(): Promise<TokenConfig> {
    try {
      if (existsSync(TOKEN_CONFIG_FILE)) {
        const raw = await readFile(TOKEN_CONFIG_FILE, "utf-8");
        return { ...DEFAULT_TOKEN_CONFIG, ...JSON.parse(raw) };
      }
    } catch {}
    return { ...DEFAULT_TOKEN_CONFIG };
  }

  async function saveTokenConfig(cfg: TokenConfig) {
    await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
    await writeFile(TOKEN_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  }

  function isContextStyle(v: unknown): v is ContextStyle {
    return typeof v === "string" && ["pct-window", "used-window", "pct", "used", "bar"].includes(v);
  }
  function isSpeedStyle(v: unknown): v is SpeedStyle {
    return typeof v === "string" && ["t/s", "tok/s", "T/s", "liveAt"].includes(v);
  }

  async function loadDisplayConfig(): Promise<DisplayConfig> {
    try {
      if (existsSync(DISPLAY_CONFIG_FILE)) {
        const raw = await readFile(DISPLAY_CONFIG_FILE, "utf-8");
        const saved = JSON.parse(raw) as DisplayConfig;
        // 与默认值合并，防止新增条目缺失
        const merged: DisplayConfig = {
          ...DEFAULT_DISPLAY_CONFIG,
          items: { ...DEFAULT_DISPLAY_CONFIG.items },
        };
        if (saved.items) {
          for (const key of Object.keys(merged.items) as DisplayKey[]) {
            if (typeof saved.items[key] === "boolean") merged.items[key] = saved.items[key];
          }
        }
        if (isContextStyle(saved.contextStyle)) merged.contextStyle = saved.contextStyle;
        if (isSpeedStyle(saved.speedStyle)) merged.speedStyle = saved.speedStyle;
        return merged;
      }
    } catch {}
    return { ...DEFAULT_DISPLAY_CONFIG, items: { ...DEFAULT_DISPLAY_CONFIG.items } };
  }

  async function saveDisplayConfig(cfg: DisplayConfig) {
    await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
    await writeFile(DISPLAY_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  }

  // ── 缓存操作 ─────────────────────────────────────────

  async function readQuotaCache(): Promise<QuotaCache> {
    try {
      if (existsSync(QUOTA_CACHE_FILE)) {
        const raw = await readFile(QUOTA_CACHE_FILE, "utf-8");
        return JSON.parse(raw);
      }
    } catch {}
    return {};
  }

  async function writeQuotaCache(cache: QuotaCache) {
    await ensureDir(LOGS_DIR);
    await writeFile(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  }

  // ── 匹配逻辑 ─────────────────────────────────────────

  function resolveActivePlan(provider?: string): TokenPlan | null {
    if (!tokenConfig) return null;
    const planId = provider ? (tokenConfig.providerPlans[provider] ?? null) : null;
    if (!planId) return null;
    return BUILTIN_PLANS.find(p => p.id === planId) || null;
  }

  function resolveApiKey(plan: TokenPlan): string | null {
    // 1. 环境变量优先
    if (plan.apiKeyEnv && process.env[plan.apiKeyEnv]) {
      return process.env[plan.apiKeyEnv]!;
    }
    // 2. 读取 pi 的 auth.json
    try {
      const authPath = join(homedir(), ".pi/agent/auth.json");
      if (existsSync(authPath)) {
        const raw = readFileSync(authPath, "utf-8");
        const auth = JSON.parse(raw);
        for (const providerId of plan.matchProviders) {
          const entry = auth[providerId];
          if (entry?.key) return entry.key;
        }
      }
    } catch {}
    return null;
  }

  /**
   * 解析套餐的团队凭证（当前仅 GLM/智谱团队版）。
   * 组织 ID + 项目 ID 二者齐全才返回，否则返回 null（回退个人版查询）。
   * 来源：token-stats config.json 的 teamCredential（/stats 菜单配置）。
   */
  function resolveTeamCredential(plan: TokenPlan): TeamCredential | null {
    if (plan.id !== "glm") return null;
    const tc = tokenConfig?.teamCredential;
    const organization = tc?.organization?.trim() ?? "";
    const project = tc?.project?.trim() ?? "";
    if (organization && project) return { organization, project };
    return null;
  }

  /**
   * 检测并处理 provider 变化。
   * 返回 true 表示发生了切换（供调用者决定是否要 force refresh）。
   */
  function detectAndHandleProviderChange(ctx: ExtensionContext): boolean {
    const curProvider = ctx.model?.provider ?? null;
    if (!curProvider) {
      // provider 缺失：清空 quotaState，不刷新
      if (quotaState) quotaState = null;
      lastQuotaProvider = null;
      return false;
    }
    if (curProvider === lastQuotaProvider) return false;
    // 切换发生：先记录新 provider，再清旧 state
    lastQuotaProvider = curProvider;
    quotaState = null;
    return true;
  }

  function buildErrorState(
    provider: string,
    planId: string,
    error: QuotaError,
  ): QuotaDisplayState {
    let display = "无数据";
    if (error.kind === "key_missing") {
      display = `❌ ${error.envVar} 未设置`;
    } else if (error.kind === "api_error") {
      display = `❌ ${truncateText(error.message, 24)}`;
    } else if (error.kind === "network_error") {
      display = `❌ 网络/超时`;
    } else if (error.kind === "no_data") {
      display = "无数据";
    } else if (error.kind === "no_plan") {
      display = "未启用";
    }
    return {
      planId,
      provider,
      display,
      modelPrefix: "",
      color: "err",
      error,
      fetchedAt: Date.now(),
    };
  }

  function truncateText(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  /**
   * 把 quotaState.error 格式化为人类可读提示。
   */
  function formatQuotaError(state: QuotaDisplayState | null | undefined): string {
    if (!state || !state.error) return t("未知错误", "Unknown error");
    const e = state.error;
    switch (e.kind) {
      case "no_plan":
        return t("该 provider 未配置套餐", "No quota plan configured for this provider");
      case "key_missing":
        return t(
          `未设置环境变量 ${e.envVar} 或 ~/.pi/agent/auth.json 中 ${e.provider} 的 key 字段`,
          `Missing env var ${e.envVar} or key field for ${e.provider} in ~/.pi/agent/auth.json`,
        );
      case "api_error":
        return `API ${t("返回错误", "error")}: ${e.message}`;
      case "network_error":
        return `${t("网络/超时", "Network timeout")}: ${e.message}`;
      case "no_data":
        return t("接口返回无数据", "API returned no data");
    }
  }

  /**
   * 刷新套餐用量。
   * force=true 时绕过缓存（用于 provider 切换 / 手动刷新 / session_start）。
   */
  async function refreshQuota(ctx: ExtensionContext, force = false): Promise<void> {
    // 1. 先检测 provider 变化（可能清空 quotaState）
    detectAndHandleProviderChange(ctx);

    const curProvider = ctx.model?.provider;
    if (!curProvider) return; // provider 缺失：不显示

    // 2. 解析 plan
    const plan = resolveActivePlan(curProvider);
    if (!plan) {
      // 用户没启用套餐：静默隐藏该段
      quotaState = null;
      return;
    }

    // 3. 解析 key
    const key = resolveApiKey(plan);
    if (!key) {
      quotaState = buildErrorState(curProvider, plan.id, {
        kind: "key_missing",
        envVar: plan.apiKeyEnv || "API_KEY",
        provider: curProvider,
      });
      return;
    }

    // 4. 读缓存（force 时跳过）
    const cache = await readQuotaCache();
    const cached = cache[plan.id];
    const ttlMs = (tokenConfig?.ttl || 60) * 1000;
    if (!force && cached && (Date.now() - cached.fetchedAt) < cached.ttl) {
      const fmt = plan.format(cached.data);
      quotaState = {
        planId: plan.id,
        provider: curProvider,
        display: fmt.display,
        modelPrefix: fmt.modelPrefix,
        color: fmt.color,
        fetchedAt: cached.fetchedAt,
      };
      return;
    }

    // 5. 调接口
    try {
      const data = await plan.fetchQuota(
        plan,
        key,
        { team: resolveTeamCredential(plan) },
      );
      cache[plan.id] = { fetchedAt: Date.now(), ttl: ttlMs, data };
      await writeQuotaCache(cache);
      const fmt = plan.format(data);
      // format 可能返回 "无数据" 颜色为 err
      if (fmt.color === "err" && fmt.display === "无数据") {
        quotaState = buildErrorState(curProvider, plan.id, { kind: "no_data" });
        quotaState.display = fmt.display;
        quotaState.modelPrefix = fmt.modelPrefix;
        return;
      }
      quotaState = {
        planId: plan.id,
        provider: curProvider,
        display: fmt.display,
        modelPrefix: fmt.modelPrefix,
        color: fmt.color,
        fetchedAt: Date.now(),
      };
    } catch (e: any) {
      // 区分网络错误与 API 业务错误
      const msg = e?.message || String(e);
      const isNetwork = /timeout|abort|fetch failed|network|econnreset|enotfound/i.test(msg);
      quotaState = buildErrorState(curProvider, plan.id, isNetwork
        ? { kind: "network_error", message: msg }
        : { kind: "api_error", message: msg },
      );
    }
  }

  async function forceRefreshQuota(ctx: ExtensionContext) {
    await refreshQuota(ctx, true);
    shared.requestRender?.();
  }

  /** config.json 无参流里的基础结构（避免 null 展开报错） */
  function baseTokenConfig(): TokenConfig {
    return { ...(tokenConfig ?? { providerPlans: {}, ttl: 60 }) };
  }

  /**
   * GLM 团队套餐交互配置：提示用户填写组织 ID / 项目 ID 并持久化到 config.json，
   * 保存后 force 刷新使团队查询（?type=2）立即生效，并反馈查询结果。
   */
  async function promptGlmTeamConfig(ctx: ExtensionContext): Promise<void> {
    const cur = tokenConfig?.teamCredential;
    const curLabel =
      cur?.organization && cur?.project
        ? `${cur.organization} / ${cur.project}`
        : t("未配置（按个人版查询）", "not configured (personal query)");
    const prompts = [t("✏️ 配置/修改", "✏️ Configure / Edit"), t("跳过", "Skip")];
    const choice = await ctx.ui.select(
      t(
        `GLM 团队套餐凭证？当前：${curLabel}\n填写组织 ID + 项目 ID（二者齐全才走团队查询 ?type=2），跳过则维持个人版查询`,
        `GLM team plan credentials? Current: ${curLabel}\nEnter organization ID + project ID (team query ?type=2 needs both), skip to keep personal query`,
      ),
      prompts,
    );
    if (!choice || choice === prompts[1]) {
      await forceRefreshQuota(ctx);
      const errMsg = quotaState?.error ? formatQuotaError(quotaState) : "";
      ctx.ui.notify(
        quotaState?.error
          ? t(`GLM 配额查询失败：${errMsg}`, `GLM quota query failed: ${errMsg}`)
          : t("GLM 配额已启用（个人版查询）", "GLM quota enabled (personal query)"),
        "info",
      );
      return;
    }

    const organization = await ctx.ui.input("组织 ID (Organization)", cur?.organization ?? "");
    const project = await ctx.ui.input("项目 ID (Project)", cur?.project ?? "");
    const org = organization?.trim() ?? "";
    const proj = project?.trim() ?? "";
    if (!org || !proj) {
      ctx.ui.notify(t("组织/项目 ID 不能为空，团队凭证未保存", "Organization/Project ID cannot be empty, credentials not saved"), "warning");
      return;
    }

    tokenConfig = {
      ...baseTokenConfig(),
      teamCredential: { organization: org, project: proj },
    };
    await saveTokenConfig(tokenConfig);

    await forceRefreshQuota(ctx);
    const errMsg = quotaState?.error ? formatQuotaError(quotaState) : "";
    ctx.ui.notify(
      quotaState?.error
        ? t(`GLM 团队配额查询失败：${errMsg}`, `GLM team quota query failed: ${errMsg}`)
        : t("GLM 团队套餐配额已启用", "GLM team quota enabled"),
      "info",
    );
  }

  /** 清空所有套餐缓存（session_start 调，避免跨 session 复用旧数据） */
  async function invalidateAllQuotaCache() {
    try {
      if (existsSync(QUOTA_CACHE_FILE)) {
        await writeFile(QUOTA_CACHE_FILE, "{}", "utf-8");
      }
    } catch { /* ignore */ }
  }

  // ── /stats 命令 ───────────────────────────────────────

  function weightedCacheHitRate(d: { sumInput: number; sumCacheRead: number; sumCacheWrite: number }): number {
    const total = d.sumInput + d.sumCacheRead + d.sumCacheWrite;
    return total > 0 ? (d.sumCacheRead / total) * 100 : 0;
  }

  function renderDaySummary(daily: DailyRecord): string[] {
    const d = daily;
    const avgInput = d.count > 0 ? d.sumInput / d.count : 0;
    const avgOutput = d.count > 0 ? d.sumOutput / d.count : 0;
    const totalPrompt = d.sumInput + d.sumCacheRead + d.sumCacheWrite;
    const cacheHitRate = weightedCacheHitRate(d);

    return renderTable(
      [t("指标", "Metric"), t("数值", "Value")],
      [
        [t("对话次数", "Sessions"), String(d.count)],
        [t("新增输入", "New input"), `${formatTokens(d.sumInput)}（${t("平均", "avg")} ${formatTokens(avgInput)}/次，${t("未命中缓存", "uncached")}）`],
        [t("缓存输入", "Cached input"), formatTokens(d.sumCacheRead)],
        [t("总输出", "Total output"), `${formatTokens(d.sumOutput)}（${t("平均", "avg")} ${formatTokens(avgOutput)}/次）`],
        [t("总token", "Total tokens"), `${formatTokens(totalPrompt)}（${t("新增 + 缓存", "new + cached")}）`],
        [t("缓存命中率", "Cache hit rate"), `${cacheHitRate.toFixed(1)}%`],
        [t("平均速率", "Avg speed"), `${(d.sumTokensPerSec / d.count).toFixed(1)} t/s`],
      ],
    );
  }

  async function showStats(
    lines: string[],
    title: string,
    ctx: ExtensionContext,
  ) {
    const text = `## ${title}\n\n${lines.join("\n")}`;
    pi.sendMessage({
      customType: "token-stats",
      content: text,
      display: true,
      details: {},
    });
  }

  async function showDay(date: string, ctx: ExtensionContext) {
    let records: DailyRecord[] = [];
    try {
      records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // nothing
    }
    const daily = records.find((r) => r.date === date) || null;

    if (!daily) {
      ctx.ui.notify(t(`${date} 暂无统计数据`, `No stats for ${date}`), "info");
      return;
    }

    await showStats(
      [...renderDaySummary(daily), ...renderModelBreakdown(await readRawRecordsForDates([date]))],
      t(`Token 统计  |  ${date}`, `Token stats  |  ${date}`),
      ctx,
    );
  }

  async function showHourly(date: string, ctx: ExtensionContext) {
    const file = join(HOURLY_DIR, `${date}.jsonl`);
    let records: HourlyRecord[] = [];
    try {
      records = (await readFile(file, "utf-8")).trim().split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // nothing
    }

    if (records.length === 0) {
      ctx.ui.notify(t(`${date} 暂无按小时统计`, `No hourly stats for ${date}`), "info");
      return;
    }

    records.sort((a, b) => a.hour - b.hour);

    const lines = renderTable(
      [t("时间", "Time"), t("次数", "Count"), t("新增输入", "New input"), t("缓存输入", "Cached input"), t("输出", "Output"), t("总token", "Total tokens"), t("命中率", "Hit rate"), t("速率", "Speed")],
      records.map((r) => {
        const totalPrompt = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
        return [
          String(r.hour).padStart(2, "0"),
          String(r.count),
          formatTokens(r.sumInput),
          formatTokens(r.sumCacheRead),
          formatTokens(r.sumOutput),
          formatTokens(totalPrompt),
          `${weightedCacheHitRate(r).toFixed(1)}%`,
          `${(r.sumTokensPerSec / r.count).toFixed(1)}`,
        ];
      }),
      {
        aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
      },
    );

    await showStats(lines, `按小时分布  |  ${date}`, ctx);
  }

  async function showWeek(ctx: ExtensionContext) {
    let records: DailyRecord[] = [];
    try {
      records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // nothing
    }

    // 最近 7 天
    const today = getDateStr();
    const sevenDaysAgo = getDateStr(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    );
    const weekRecords = records
      .filter((r) => r.date >= sevenDaysAgo && r.date <= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (weekRecords.length === 0) {
      ctx.ui.notify(t("本周暂无统计数据", "No stats for this week"), "info");
      return;
    }

    const lines = renderTable(
      [t("日期", "Date"), t("次数", "Count"), t("新增输入", "New input"), t("缓存输入", "Cached input"), t("输出", "Output"), t("总token", "Total tokens"), t("命中率", "Hit rate"), t("速率", "Speed")],
      weekRecords.map((r) => {
        const totalPrompt = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
        return [
          r.date,
          String(r.count),
          formatTokens(r.sumInput),
          formatTokens(r.sumCacheRead),
          formatTokens(r.sumOutput),
          formatTokens(totalPrompt),
          `${weightedCacheHitRate(r).toFixed(1)}%`,
          `${(r.sumTokensPerSec / r.count).toFixed(1)}`,
        ];
      }),
      {
        aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
      },
    );

    await showStats(
      [...lines, ...renderModelBreakdown(await readRawRecordsInRange(sevenDaysAgo, today))],
      t("本周每天汇总", "Week summary by day"),
      ctx,
    );
  }

  function getMonthStr(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  async function showMonth(month: string, ctx: ExtensionContext) {
    let records: DailyRecord[] = [];
    try {
      records = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // nothing
    }

    const monthRecords = records
      .filter((r) => r.date.startsWith(month))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (monthRecords.length === 0) {
      ctx.ui.notify(t(`${month} 暂无统计数据`, `No stats for ${month}`), "info");
      return;
    }

    // 累计
    const total = monthRecords.reduce(
      (acc, r) => {
        acc.count += r.count;
        acc.sumInput += r.sumInput;
        acc.sumCacheRead += r.sumCacheRead;
        acc.sumCacheWrite += r.sumCacheWrite;
        acc.sumOutput += r.sumOutput;
        acc.sumTokensPerSec += r.sumTokensPerSec;
        return acc;
      },
      { count: 0, sumInput: 0, sumCacheRead: 0, sumCacheWrite: 0, sumOutput: 0, sumTokensPerSec: 0 },
    );
    const totalPrompt = total.sumInput + total.sumCacheRead + total.sumCacheWrite;
    const cacheHitRate = weightedCacheHitRate(total);

    const lines = renderTable(
      [t("日期", "Date"), t("次数", "Count"), t("新增输入", "New input"), t("缓存输入", "Cached input"), t("输出", "Output"), t("总token", "Total tokens"), t("命中率", "Hit rate"), t("速率", "Speed")],
      monthRecords.map((r) => {
        const tp = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
        return [
          r.date,
          String(r.count),
          formatTokens(r.sumInput),
          formatTokens(r.sumCacheRead),
          formatTokens(r.sumOutput),
          formatTokens(tp),
          `${weightedCacheHitRate(r).toFixed(1)}%`,
          `${(r.sumTokensPerSec / r.count).toFixed(1)}`,
        ];
      }),
      {
        aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
        totalRow: [
          t("合计", "Total"),
          String(total.count),
          formatTokens(total.sumInput),
          formatTokens(total.sumCacheRead),
          formatTokens(total.sumOutput),
          formatTokens(totalPrompt),
          `${cacheHitRate.toFixed(1)}%`,
          `${(total.sumTokensPerSec / total.count).toFixed(1)}`,
        ],
      },
    );

    const monthDates = monthRecords.map((r) => r.date).sort();
    await showStats(
      [
        ...lines,
        ...renderModelBreakdown(
          await readRawRecordsInRange(monthDates[0], monthDates[monthDates.length - 1]),
        ),
      ],
      `${month} 月度汇总`,
      ctx,
    );
  }

  // ── 事件注册 ─────────────────────────────────────────

  // ── message renderer: 渲染 /stats 发出的消息（markdown 表格）──
  pi.registerMessageRenderer("token-stats", (message, _options, theme) => {
    return new Markdown(message.content, 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("dim", text),
    });
  });

  // ── agent_start: 重置 run 级 token 累加 ──────────
  pi.on("agent_start", (_event, _ctx) => {
    resetRunStats();
  });

  // ── turn_start: 记录时间 + 检测供应商切换 ──────────
  pi.on("turn_start", async (_event, ctx) => {
    stats.turnStartTime = Date.now();
    stats.firstTokenTime = 0;
    stats.streaming = false;

    // turn_start 也能触发 provider 变化检测；切换时 force refresh
    if (ctx.model?.provider !== lastQuotaProvider) {
      lastQuotaProvider = ctx.model?.provider ?? null;
      quotaState = null; // 跨 provider 立即清旧 state
      await refreshQuota(ctx, true); // force 绕过缓存
      shared.requestRender?.();
    }

    shared.requestRender?.();
  });

  // ── message_update: 流式实时估算 + rolling window ────
  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    const streamEvent = (event as any).assistantMessageEvent;
    if (
      streamEvent?.type !== "text_delta" &&
      streamEvent?.type !== "thinking_delta" &&
      streamEvent?.type !== "toolcall_delta"
    ) {
      // 非 delta 事件仍需要更新部分状态
      if (stats.firstTokenTime === 0) stats.firstTokenTime = Date.now();
      stats.streaming = true;
      return;
    }

    // 记录首个 token 到达时间
    if (stats.firstTokenTime === 0) stats.firstTokenTime = Date.now();
    stats.streaming = true;

    const nowMs = Date.now();
    stats.liveOutputChars += streamEvent.delta.length;

    // 优先使用 pi 框架返回的 partial usage
    const usageOutputTokens = streamEvent.partial?.usage?.output;
    let newTokens = 0;
    if (
      typeof usageOutputTokens === "number" &&
      usageOutputTokens > stats.liveUsageOutputTokens
    ) {
      newTokens = usageOutputTokens - stats.liveUsageOutputTokens;
      stats.liveUsageOutputTokens = usageOutputTokens;
      stats.liveEstimatedTokens = usageOutputTokens;
    } else if (stats.liveUsageOutputTokens <= 0) {
      // 回退到字符估算
      const estimated = estimateTokens(stats.liveOutputChars);
      newTokens = Math.max(0, estimated - stats.liveEstimatedTokens);
      stats.liveEstimatedTokens = estimated;
    }

    if (newTokens > 0) {
      stats.liveTokenSamples.push({ timestampMs: nowMs, tokens: newTokens });
    }

    shared.requestRender?.();
  });

  // ── message_end: 精确统计 + 持久化 ──────────────────
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const assistantMsg = event.message as AssistantMessage;
    const usage = assistantMsg.usage;
    if (!usage) return;

    // 去重：使用 responseId 防止 message_end + turn_end 重复累加
    const usageKey = assistantMsg.responseId ||
      `${assistantMsg.timestamp}:${assistantMsg.provider}:${assistantMsg.model}:${usage.input}:${usage.output}`;
    if (stats.accountedUsageKeys.has(usageKey)) return;
    stats.accountedUsageKeys.add(usageKey);

    // 流总耗时（秒）
    const totalElapsed =
      stats.turnStartTime > 0
        ? (Date.now() - stats.turnStartTime) / 1000
        : 0;
    // 过滤异常：< 50ms 视为不可信
    const tokensPerSec =
      totalElapsed >= 0.05 ? usage.output / totalElapsed : 0;
    // rolling window 速率（优先于平均速率）
    const liveSpeed = getRollingLiveTokenSpeed();
    // 首 token 延迟（毫秒）
    const firstTokenLatency =
      stats.firstTokenTime > 0 && stats.turnStartTime > 0
        ? stats.firstTokenTime - stats.turnStartTime
        : 0;
    // 词数
    const wordCount = countWords(
      extractTextContent(event.message.content),
    );
    // 缓存命中率（pi 内置公式）
    const promptTokens =
      usage.input + usage.cacheRead + usage.cacheWrite;
    const cacheHitRate =
      promptTokens > 0
        ? (usage.cacheRead / promptTokens) * 100
        : 0;
    // 花费
    const cost = usage.cost?.total ?? 0;

    // 更新本轮精确值
    stats.lastInput = usage.input;
    stats.lastOutput = usage.output;
    stats.lastCacheRead = usage.cacheRead;
    stats.lastCacheWrite = usage.cacheWrite;
    stats.lastCost = cost;
    stats.lastCacheHitRate = cacheHitRate;
    stats.lastTokensPerSec = tokensPerSec;
    stats.lastLiveTokenSpeed = liveSpeed;
    stats.lastFirstTokenLatency = firstTokenLatency;
    stats.lastWordCount = wordCount;
    stats.streaming = false;

    // 累加到会话
    stats.totalInput += usage.input;
    stats.totalOutput += usage.output;
    stats.totalCacheRead += usage.cacheRead;
    stats.totalCacheWrite += usage.cacheWrite;
    stats.totalCost += cost;
    stats.totalCacheHitRateSum += cacheHitRate;
    stats.turnCount++;

    // 累加到当前 run（agent_start → agent_settled）
    runStats.input += usage.input;
    runStats.output += usage.output;
    runStats.cacheRead += usage.cacheRead;
    runStats.cacheWrite += usage.cacheWrite;
    runStats.turns++;
    runLastMsgMs = Date.now();

    shared.requestRender?.();

    // 持久化
    const sessionId =
      ctx.sessionManager.getSessionId?.() ?? "unknown";
    const model = `${event.message.provider}/${event.message.model}`;
    await persistTurn({
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      tokensPerSec,
      cacheHitRate,
      model,
      firstTokenLatency,
      wordCount,
      cost,
      liveTokenSpeed: liveSpeed,
    }, sessionId);

    // 重置 live 状态
    resetLiveState();
  });

  // ── agent_end: 整个对话结束，确保最终状态刷新 ────────
  pi.on("agent_end", async (_event, _ctx) => {
    stats.streaming = false;
    resetLiveState();
    shared.requestRender?.();
  });

  // ── session_shutdown: 清理跨 session 资源（定时器 / footer 引用）───────
  pi.on("session_shutdown", async (_event, _ctx) => {
    // session 替换（/new /resume /fork）或 /reload 时旧 ctx 会失效，
    // 必须在此清掉旧实例的定时器与闭包引用，否则定时器回调访问旧 ctx
    // 会抛 "extension ctx is stale" 导致 pi 崩溃退出。
    shared.sessionActive = false;
    if (quotaTimerId) {
      clearInterval(quotaTimerId);
      quotaTimerId = null;
    }
    shared.requestRender = null;
    lastQuotaProvider = null;
    quotaState = null;
  });

  // ── session_start: 恢复累计状态 + 定时刷新配额 ──────
  pi.on("session_start", async (_event, ctx) => {
    shared.sessionActive = true;
    rebuildFromHistory(ctx);

    // 套餐用量：加载配置 + 定时刷新
    tokenConfig = await loadTokenConfig();
    displayConfig = await loadDisplayConfig();
    lastQuotaProvider = null; // 强制让 refreshQuota 检测一次
    quotaState = null;
    // 清空所有 plan 的缓存（避免跨 session 复用旧数据）
    await invalidateAllQuotaCache();
    if (quotaTimerId) clearInterval(quotaTimerId);
    // 第一次强制刷新（绕缓存）
    await refreshQuota(ctx, true);
    shared.requestRender?.();
    quotaTimerId = setInterval(async () => {
      if (!shared.sessionActive) return;
      try {
        // 定时器也先检测 provider 变化；变化则 force refresh
        if (ctx.model?.provider !== lastQuotaProvider) {
          await refreshQuota(ctx, true);
        } else {
          await refreshQuota(ctx, false);
        }
      } catch { /* ctx 已失效（session 被替换），忽略本次刷新 */ }
      shared.requestRender?.();
    }, (tokenConfig?.ttl || 60) * 1000);
  });

  // ── /stats 命令 ─────────────────────────────────────

  pi.registerCommand("stats", {
    description: t(
      "Token 统计 (day | hour | week | month | config | limit)  无参默认显示当天统计；limit 进入套餐配置",
      "Token stats (day | hour | week | month | config | limit)  No arg shows today; limit enters quota plan config",
    ),
    handler: async (args, ctx) => {
      const arg = args.trim();

      // 无参 → 当天统计（等价于 /stats day）
      if (!arg) {
        await showDay(getDateStr(), ctx);
        return;
      }

      // limit → 套餐配置（原无参行为）
      if (arg === "limit") {
        const provider = ctx.model?.provider;
        if (!provider) {
          ctx.ui.notify(t("无法获取当前供应商，请先切换对话", "Cannot get current provider, switch conversation first"), "warning");
          return;
        }
        // 套餐用量选择菜单
        const options = [t("关闭", "Off"), ...BUILTIN_PLANS.map(p => p.name)];
        const choice = await ctx.ui.select(
          t("选择 " + provider + " 要显示配额的套餐（选中后退出）", "Select quota plan to show for " + provider + " (select to exit)"),
          options,
        );

        const defaults: TokenConfig = { providerPlans: {}, ttl: 60 };

        if (!choice || choice === options[0]) {
          tokenConfig = tokenConfig
            ? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: null } }
            : { ...defaults, providerPlans: { [provider]: null } };
          await saveTokenConfig(tokenConfig);
          lastQuotaProvider = provider;
          quotaState = null;
          if (quotaTimerId) clearInterval(quotaTimerId);
          quotaTimerId = setInterval(async () => {
            if (!shared.sessionActive) return;
            try {
              await refreshQuota(ctx);
            } catch { /* ctx 已失效（session 被替换），忽略 */ }
            shared.requestRender?.();
          }, (tokenConfig?.ttl || 60) * 1000);
          shared.requestRender?.();
          ctx.ui.notify(t(provider + " 的套餐用量已关闭", "Quota display for " + provider + " is off"), "info");
          return;
        }
        const plan = BUILTIN_PLANS.find(p => p.name === choice);
        if (plan) {
          tokenConfig = tokenConfig
            ? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: plan.id } }
            : { ...defaults, providerPlans: { [provider]: plan.id } };
          await saveTokenConfig(tokenConfig);
          lastQuotaProvider = provider;
          // 立即查询
          await forceRefreshQuota(ctx);
          if (quotaTimerId) clearInterval(quotaTimerId);
          quotaTimerId = setInterval(async () => {
            if (!shared.sessionActive) return;
            try {
              await refreshQuota(ctx);
            } catch { /* ctx 已失效（session 被替换），忽略 */ }
            shared.requestRender?.();
          }, (tokenConfig?.ttl || 60) * 1000);
          if (plan.id === "glm") {
            // GLM：继续询问团队套餐凭证（个人版/团队版二选一，内部会 force 查询并反馈）
            await promptGlmTeamConfig(ctx);
            return;
          }
          if (quotaState?.error) {
            // 仅当 quotaState 带有 error 字段时（key 缺失 / API 错误 / 网络错误 / 无数据）才提示"查询失败"
            const errMsg = formatQuotaError(quotaState);
            ctx.ui.notify(t(`${plan.name} 配额查询失败：${errMsg}`, `${plan.name} quota query failed: ${errMsg}`), "info");
          } else {
            ctx.ui.notify(t(plan.name + " 配额已启用", plan.name + " quota enabled"), "info");
          }
        }
        return;
      }

      if (arg === "config") {
        const cfgOpts = [
          t("显示样式", "Display style"),
          t("显示内容", "Display items"),
          t(`刷新时间  (当前 ${tokenConfig?.ttl || 60}s)`, `Refresh interval (current ${tokenConfig?.ttl || 60}s)`),
          t("GLM 团队凭证", "GLM team credentials"),
        ];
        const subChoice = await ctx.ui.select(t("配置", "Settings"), cfgOpts);
        if (!subChoice) return;

        if (subChoice === cfgOpts[3]) {
          const cur = tokenConfig?.teamCredential;
          const label =
            cur?.organization && cur?.project
              ? `${cur.organization} / ${cur.project}`
              : t("未配置", "not configured");
          const actions = [
            t("✏️ 配置/修改", "✏️ Configure / Edit"),
            t("清除", "Clear"),
            t("返回", "Back"),
          ];
          const action = await ctx.ui.select(t("GLM 团队凭证（当前: " + label + "）", "GLM team credentials (current: " + label + ")"), actions);
          if (!action || action === actions[2]) return;
          if (action === actions[1]) {
            tokenConfig = {
              ...baseTokenConfig(),
              teamCredential: { organization: "", project: "" },
            };
            await saveTokenConfig(tokenConfig);
            await forceRefreshQuota(ctx);
            ctx.ui.notify(t("GLM 团队凭证已清除（恢复个人版查询）", "GLM team credentials cleared (back to personal query)"), "info");
          } else {
            const organization = await ctx.ui.input("组织 ID (Organization)", cur?.organization ?? "");
            const project = await ctx.ui.input("项目 ID (Project)", cur?.project ?? "");
            const org = organization?.trim() ?? "";
            const proj = project?.trim() ?? "";
            if (!org || !proj) {
              ctx.ui.notify(t("组织/项目 ID 不能为空，未保存", "Organization/Project ID cannot be empty, not saved"), "warning");
              return;
            }
            tokenConfig = {
              ...baseTokenConfig(),
              teamCredential: { organization: org, project: proj },
            };
            await saveTokenConfig(tokenConfig);
            await forceRefreshQuota(ctx);
            const errMsg = quotaState?.error ? formatQuotaError(quotaState) : "";
            if (quotaState?.error) {
              ctx.ui.notify(t(`GLM 团队配额查询失败：${errMsg}`, `GLM team quota query failed: ${errMsg}`), "info");
            } else {
              ctx.ui.notify(t("GLM 团队凭证已保存（团队查询已生效）", "GLM team credentials saved (team query active)"), "info");
            }
          }
          return;
        }

        if (subChoice === cfgOpts[0]) {
          const catOpts = [t("上下文样式", "Context style"), t("⚡ 速率样式", "⚡ Speed style")];
          const catChoice = await ctx.ui.select(t("选择要配置的样式类别", "Select style category to configure"), catOpts);
          if (!catChoice) return;

          if (catChoice === catOpts[0]) {
            const items: { label: string; value: ContextStyle; preview: string }[] = [
              { label: "pct-window", value: "pct-window", preview: `5.3%/1.0M` },
              { label: "used-window", value: "used-window", preview: `256k/1.0M` },
              { label: "pct", value: "pct", preview: `5.3%` },
              { label: "used", value: "used", preview: `256k` },
              { label: "bar", value: "bar", preview: `[██░░░░░░] 25%` },
            ];
            const choice = await ctx.ui.select(
              t("上下文样式（当前: " + displayConfig.contextStyle + "）", "Context style (current: " + displayConfig.contextStyle + ")"),
              items.map(i =>
                (displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview
              ),
            );
            if (choice) {
              const idx = items.findIndex(i =>
                (displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview === choice
              );
              if (idx >= 0) {
                displayConfig = { ...displayConfig, contextStyle: items[idx].value };
                await saveDisplayConfig(displayConfig);
                shared.requestRender?.();
              }
            }
          } else {
            const items: { label: string; value: SpeedStyle; preview: string }[] = [
              { label: "t/s", value: "t/s", preview: `⚡77.7 t/s` },
              { label: "tok/s", value: "tok/s", preview: `⚡77.7 tok/s` },
              { label: "T/s", value: "T/s", preview: `⚡77.7 T/s` },
              { label: t("live@速率", "live@rate"), value: "liveAt", preview: `⚡1.2k@77.7` },
            ];
            const choice = await ctx.ui.select(
              t("⚡ 速率样式（当前: " + displayConfig.speedStyle + "）", "⚡ Speed style (current: " + displayConfig.speedStyle + ")"),
              items.map(i =>
                (displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview
              ),
            );
            if (choice) {
              const idx = items.findIndex(i =>
                (displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label + "  " + i.preview === choice
              );
              if (idx >= 0) {
                displayConfig = { ...displayConfig, speedStyle: items[idx].value };
                await saveDisplayConfig(displayConfig);
                shared.requestRender?.();
              }
            }
          }
          ctx.ui.notify(t("显示样式已保存", "Display style saved"), "info");
        } else if (subChoice === cfgOpts[1]) {
          const itemLabels: DisplayKey[] = [
            "input", "output", "totalTokens", "cacheHit", "speed", "context",
            "quota5h", "quotaWeek", "quotaMonth", "quotaClock",
          ];
          const itemNames: Record<DisplayKey, string> = {
            input: t("输入", "Input"), output: t("输出", "Output"), totalTokens: t("总token", "Total tokens"),
            cacheHit: t("缓存命中", "Cache hit"), speed: t("速度", "Speed"), context: t("容量", "Context"),
            quota5h: t("5h额度", "5h quota"), quotaWeek: t("周额度", "Week quota"), quotaMonth: t("月额度", "Month quota"), quotaClock: t("刷新时间", "Refresh time"),
          };
          while (true) {
            const options = itemLabels.map(k =>
              `${displayConfig.items[k] ? "✅" : "⬜"} ${itemNames[k]}`,
            );
            options.push(t("🔙 完成", "🔙 Done"));
            const choice = await ctx.ui.select(t("选择要切换显示的项目", "Select items to toggle"), options);
            if (!choice || choice === options[options.length - 1]) break;
            const idx = options.indexOf(choice);
            if (idx >= 0 && idx < itemLabels.length) {
              const key = itemLabels[idx];
              displayConfig = {
                ...displayConfig,
                items: { ...displayConfig.items, [key]: !displayConfig.items[key] },
              };
              await saveDisplayConfig(displayConfig);
              shared.requestRender?.();
            }
          }
          ctx.ui.notify(t("状态栏显示配置已保存", "Status bar display config saved"), "info");
        } else if (subChoice === cfgOpts[2]) {
          const input = await ctx.ui.input(t("输入刷新间隔（秒）", "Refresh interval in seconds"), String(tokenConfig?.ttl || 60));
          if (input) {
            const sec = parseInt(input, 10);
            if (Number.isNaN(sec) || sec < 10) {
              ctx.ui.notify(t("刷新时间必须 >= 10 秒", "Refresh interval must be >= 10s"), "warning");
            } else {
              tokenConfig = tokenConfig
                ? { ...tokenConfig, ttl: sec }
                : { providerPlans: {}, ttl: sec };
              await saveTokenConfig(tokenConfig);
              // 重设定时器
              if (quotaTimerId) clearInterval(quotaTimerId);
              quotaTimerId = setInterval(async () => {
                if (!shared.sessionActive) return;
                try {
                  await refreshQuota(ctx);
                } catch { /* ctx 已失效（session 被替换），忽略 */ }
                shared.requestRender?.();
              }, sec * 1000);
              ctx.ui.notify(t("刷新时间已设为 " + sec + " 秒", "Refresh interval set to " + sec + "s"), "info");
            }
          }
        }
        return;
      }

      if (arg === "today" || arg === "day") {
        await showDay(getDateStr(), ctx);
      } else if (arg.startsWith("day ")) {
        const date = arg.slice(4).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await showDay(date, ctx);
        } else {
          ctx.ui.notify(t("用法: /stats day YYYY-MM-DD", "Usage: /stats day YYYY-MM-DD"), "warning");
        }
      } else if (arg === "hour") {
        await showHourly(getDateStr(), ctx);
      } else if (arg.startsWith("hour ")) {
        const date = arg.slice(5).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await showHourly(date, ctx);
        } else {
          ctx.ui.notify(t("用法: /stats hour YYYY-MM-DD", "Usage: /stats hour YYYY-MM-DD"), "warning");
        }
      } else if (arg === "week") {
        await showWeek(ctx);
      } else if (arg === "month") {
        await showMonth(getMonthStr(), ctx);
      } else if (arg.startsWith("month ")) {
        const ms = arg.slice(6).trim();
        if (/^\d{4}-\d{2}$/.test(ms)) {
          await showMonth(ms, ctx);
        } else {
          ctx.ui.notify(t("用法: /stats month YYYY-MM", "Usage: /stats month YYYY-MM"), "warning");
        }
      } else {
        ctx.ui.notify(
          t("用法: /stats [day [date] | hour [date] | week | month [YYYY-MM] | config]", "Usage: /stats [day [date] | hour [date] | week | month [YYYY-MM] | config]"),
          "warning",
        );
      }
    },
  });

  return {
    getMetricParts,
  };
}
