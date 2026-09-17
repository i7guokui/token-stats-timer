// step-timer 模块 —— 任务计时
// =============================================================================
// 实时显示(仅交互 TUI):
//   - 任务执行中:工作指示器文案显示 "Working... 01:02"(整体已耗时,每秒刷新)
// 完成后汇总(appendEntry 持久化,不进入 LLM 上下文,resume 后可回看):
//   - agent_settled  appendEntry("timing-final", …):
//       第一行  完成时刻(24 小时制系统时间)
//       第二行  总耗时 + 耗时分解:模型(assistant 流式,含思考;紧随平均 TTFT)/
//               工具 / 其他
//       第三行  本次 run 的 token 指标(对齐 footer)
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
  /** ---- 以下为 v1.3 新增的分解字段(旧条目可能缺失) ---- */
  /** 模型耗时:assistant 消息流式(含思考)起止之和 */
  llmMs: number;
  /** 工具执行耗时(所有工具调用之和) */
  toolMs: number;
  /** 平均首 token 延迟(毫秒):turn_start → 首个流式事件;无样本时 0 */
  ttftAvgMs: number;
  /** TTFT 样本数(参与平均的 LLM 调用次数;0 = 不展示) */
  ttftCount: number;
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

/** TTFT 格式:不足 1 分钟保留 1 位小数(如 1.2s),否则 mm:ss */
function formatTtft(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

export function createStepTimer(pi: ExtensionAPI, shared: SharedState): void {
  let lastCtx: ExtensionContext | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  let runActive = false;
  let runStartMs = 0;

  // ── run 内耗时分解累计(新 run 开始时重置) ──
  let llmMs = 0;
  /** 当前 assistant 消息流式开始时刻(0 = 无进行中的 assistant 消息) */
  let streamStartMs = 0;
  let toolMs = 0;
  /** 本轮(turn)开始时刻,TTFT 起点 */
  let turnStartMs = 0;
  /** 本轮是否已记录 TTFT(每轮只取首个流式事件) */
  let ttftRecorded = false;
  let ttftSumMs = 0;
  let ttftCount = 0;
  /** toolCallId → 开始时刻(进行中的工具调用) */
  const runningTools = new Map<string, number>();

  function resetBreakdown(): void {
    llmMs = 0;
    streamStartMs = 0;
    toolMs = 0;
    turnStartMs = 0;
    ttftRecorded = false;
    ttftSumMs = 0;
    ttftCount = 0;
    runningTools.clear();
  }

  /** 收尾:闭合所有未结束的计时(中止/异常时兜底),返回时不再有进行中的条目 */
  function closeDangling(nowMs: number): void {
    if (streamStartMs > 0) {
      llmMs += Math.max(0, nowMs - streamStartMs);
      streamStartMs = 0;
    }
    for (const [id, startMs] of runningTools) {
      toolMs += Math.max(0, nowMs - startMs);
      runningTools.delete(id);
    }
  }

  // ── 工作指示器:仅整体已耗时 ──────────────────────
  function updateWorkingMessage(): void {
    if (!lastCtx?.hasUI || !runActive) return;
    lastCtx.ui.setWorkingMessage(`Working... ${formatDuration(Date.now() - runStartMs)}`);
  }

  function startTicker(): void {
    stopTicker();
    tick = setInterval(updateWorkingMessage, TICK_MS);
  }

  function stopTicker(): void {
    if (!tick) return;
    clearInterval(tick);
    tick = undefined;
  }

  function appendFinal(): void {
    const endAt = Date.now();
    closeDangling(endAt);
    pi.appendEntry<FinalTimingData>(FINAL_TYPE, {
      totalMs: endAt - runStartMs,
      endAt,
      runStats: shared.getRunStats?.() ?? null,
      llmMs,
      toolMs,
      ttftAvgMs: ttftCount > 0 ? ttftSumMs / ttftCount : 0,
      ttftCount,
    });
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    stopTicker();
    runActive = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (runActive) return; // 重试/压缩恢复等:同属一次 run,继续累计
    runActive = true;
    runStartMs = Date.now();
    resetBreakdown();
    startTicker();
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage("Working... 00:00");
  });

  // ── TTFT:每轮 turn_start → 首个流式事件,累加求平均 ──
  pi.on("turn_start", (_event, _ctx) => {
    if (!runActive) return;
    turnStartMs = Date.now();
    ttftRecorded = false;
  });

  pi.on("message_update", (event, _ctx) => {
    if (!runActive || ttftRecorded || turnStartMs <= 0) return;
    if (event.message.role !== "assistant") return;
    ttftRecorded = true; // 本轮首个流式事件(text/thinking/toolcall 任一)
    ttftSumMs += Math.max(0, Date.now() - turnStartMs);
    ttftCount += 1;
  });

  // ── 模型耗时:assistant 消息流式(含思考)起止 ──
  pi.on("message_start", (event, _ctx) => {
    if (!runActive || event.message.role !== "assistant") return;
    if (streamStartMs === 0) streamStartMs = Date.now();
  });

  pi.on("message_end", (event, _ctx) => {
    if (!runActive || event.message.role !== "assistant") return;
    if (streamStartMs > 0) {
      llmMs += Math.max(0, Date.now() - streamStartMs);
      streamStartMs = 0;
    }
  });

  // ── 工具耗时:tool_execution_start → tool_execution_end ──
  pi.on("tool_execution_start", (event, _ctx) => {
    if (!runActive) return;
    runningTools.set(event.toolCallId, Date.now());
  });

  pi.on("tool_execution_end", (event, _ctx) => {
    if (!runActive) return;
    const startMs = runningTools.get(event.toolCallId);
    if (startMs !== undefined) {
      runningTools.delete(event.toolCallId);
      toolMs += Math.max(0, Date.now() - startMs);
    }
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

    // 第二行：总耗时 + 耗时分解（分解字段 v1.3+ 才有；旧条目仅总耗时）
    const dim = (x: string) => theme.fg("dim", x);
    const seg: string[] = [];
    seg.push(`${title}：${formatDuration(d.totalMs)}`);
    if (typeof d.llmMs === "number" && typeof d.toolMs === "number") {
      const otherMs = Math.max(0, d.totalMs - d.llmMs - d.toolMs);
      // 平均 TTFT 紧随「模型」，作为模型耗时的首字延迟补充
      const ttftPart =
        typeof d.ttftAvgMs === "number" && typeof d.ttftCount === "number" && d.ttftCount > 0
          ? ` ${dim("TTFT")} ${formatTtft(d.ttftAvgMs)}`
          : "";
      const detail = [
        `${dim(t("模型", "LLM"))} ${formatDuration(d.llmMs)}${ttftPart}`,
        `${dim(t("工具", "tools"))} ${formatDuration(d.toolMs)}`,
        `${dim(t("其他", "other"))} ${formatDuration(otherMs)}`,
      ];
      seg.push(detail.join(dim(" · ")));
    }
    lines.push(seg.join("  "));

    // 第三行：本次 run 的 token 指标（对齐 footer 风格；无数据时省略）
    const s = d.runStats;
    if (s && s.hasData) {
      const ok = (x: string) => theme.fg("success", x);
      const warn = (x: string) => theme.fg("warning", x);
      const tokenSeg = [
        `↑${formatTokens(s.input)}`,
        `↓${formatTokens(s.output)}`,
        // 总token：真实全量消耗（与 footer 的 Σ 同口径）
        `Σ${formatTokens(s.input + s.cacheRead + s.cacheWrite + s.output)}`,
      ];
      const chColor = s.cacheHitRate >= 80 ? ok : s.cacheHitRate >= 50 ? (x: string) => x : warn;
      tokenSeg.push(`${dim("CH")}${chColor(`${s.cacheHitRate.toFixed(1)}%`)}`);
      tokenSeg.push(`⚡${ok(formatTokenSpeed(s.tokensPerSec))} t/s`);
      lines.push(tokenSeg.join("  "));
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });
}
