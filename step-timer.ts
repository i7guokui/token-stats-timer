// step-timer 模块 —— 任务计时
// =============================================================================
// 实时显示(仅交互 TUI):
//   - 任务执行中:工作指示器文案显示 "Working... 01:02"(整体已耗时,每秒刷新)
// 完成后汇总(appendEntry 持久化,不进入 LLM 上下文,resume 后可回看):
//   - agent_settled  appendEntry("timing-final", …):仅本次任务总耗时
//
// 一次 run = 空闲后的首个 agent_start → agent_settled(与 run-timer 语义一致,
// 包含重试、压缩恢复和排队的 steering/follow-up 提示)。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { t } from "./user-language.ts";
import {
  formatTokens,
  formatTokenSpeed,
  type RunTokenStats,
  type SharedState,
} from "./token-stats.ts";

/** 一次 run 的总耗时汇总(appendEntry "timing-final") */
export interface FinalTimingData {
  totalMs: number;
  /** 完成时刻(epoch ms),渲染为 24 小时制系统时间 */
  endAt: number;
  /** 本次 run 的 token 汇总（对齐 footer 指标；无数据时 null） */
  runStats: RunTokenStats | null;
}

const FINAL_TYPE = "timing-final";
const TICK_MS = 1000;

/** 24 小时制系统时间,如 2026-08-26 10:20:12 */
function formatSystemTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function createStepTimer(pi: ExtensionAPI, shared: SharedState): void {
  let lastCtx: ExtensionContext | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  let runActive = false;
  let runStartMs = 0;

  function startTicker(): void {
    stopTicker();
    tick = setInterval(() => {
      if (!lastCtx?.hasUI || !runActive) return;
      lastCtx.ui.setWorkingMessage(`Working... ${formatDuration(Date.now() - runStartMs)}`);
    }, TICK_MS);
  }

  function stopTicker(): void {
    if (!tick) return;
    clearInterval(tick);
    tick = undefined;
  }

  function appendFinal(): void {
    const endAt = Date.now();
    pi.appendEntry<FinalTimingData>(FINAL_TYPE, {
      totalMs: endAt - runStartMs,
      endAt,
      runStats: shared.getRunStats?.() ?? null,
    });
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    stopTicker();
    runActive = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (runActive) return;
    runActive = true;
    runStartMs = Date.now();
    startTicker();
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage("Working... 00:00");
  });

  pi.on("agent_settled", (_event, ctx) => {
    lastCtx = ctx;
    if (!runActive) return;
    appendFinal();
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage(); // 恢复默认 "Working..."
    runActive = false;
    stopTicker();
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    // 会话提前结束(如 /exit 或崩溃):尽力补一条最终汇总
    if (runActive) {
      appendFinal();
      runActive = false;
    }
    stopTicker();
    lastCtx = undefined;
  });

  pi.registerEntryRenderer<FinalTimingData>(FINAL_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const title = theme.fg("accent", t("总耗时", "Total time"));

    // 第一行：完成时刻（24 小时制系统时间）独占一行，最醒目
    const lines = [`[${formatSystemTime(d.endAt ?? Date.now())}]`];

    // 第二行：总耗时 + 本次 run 的 token 指标（对齐 footer 风格）
    const seg: string[] = [];
    seg.push(`${title}：${formatDuration(d.totalMs)}`);
    const s = d.runStats;
    if (s && s.hasData) {
      const dim = (x: string) => theme.fg("dim", x);
      const ok = (x: string) => theme.fg("success", x);
      const warn = (x: string) => theme.fg("warning", x);
      seg.push(`↑${formatTokens(s.input)}`);
      seg.push(`↓${formatTokens(s.output)}`);
      seg.push(`Σ${formatTokens(s.input + s.output)}`);
      const chColor = s.cacheHitRate >= 80 ? ok : s.cacheHitRate >= 50 ? (x: string) => x : warn;
      seg.push(`${dim("CH")}${chColor(`${s.cacheHitRate.toFixed(0)}%`)}`);
      seg.push(`⚡${ok(formatTokenSpeed(s.tokensPerSec))} t/s`);
    }
    lines.push(seg.join("  "));

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });
}