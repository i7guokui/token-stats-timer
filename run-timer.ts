// run-token-stats / run-timer 模块
// =============================================================================
// 由 @carlosgtrz/pi-run-timer 0.2.0 移植而来，与 @liziy/token-stats 合并为一个插件。
// 原实现通过 ctx.ui.setStatus 注入 footer；合并后改为提供 getStatusText()，
// 由 index.ts 把计时文本拼进统一 footer 的指标行。
//
// 显示：当前 run 已耗时 / 上一次 run 耗时 / 会话分支内最长 run 耗时（带 prompt 预览）
// 一次 run = 从空闲后的第一个 agent_start 到 agent_settled 的连续忙碌期，
// 包含重试、压缩恢复以及排队的 steering/follow-up 提示。
//
// 状态通过 pi.appendEntry 持久化到 session，/reload 后自动恢复。

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { SharedState } from "./token-stats.ts";

const STATE_TYPE = "run-timer-state";
const LEGACY_STATE_TYPE = "turn-timer-state";

type TimerState = {
  currentRunStartMs?: number;
  previousRunDurationMs?: number;
  longestRunDurationMs?: number;
};

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

function isTimerState(value: unknown): value is TimerState {
  if (!value || typeof value !== "object") return false;
  const state = value as TimerState;
  return (
    (state.currentRunStartMs === undefined || typeof state.currentRunStartMs === "number") &&
    (state.previousRunDurationMs === undefined || typeof state.previousRunDurationMs === "number") &&
    (state.longestRunDurationMs === undefined || typeof state.longestRunDurationMs === "number")
  );
}

export interface RunTimerHandle {
  /** 计时段文本，例如 "● run 01:23 · prev 00:40 · max 03:12 (Review README…)" */
  getStatusText(theme: Theme): string;
}

export function createRunTimer(
  pi: ExtensionAPI,
  shared: SharedState,
): RunTimerHandle {
  let timer: ReturnType<typeof setInterval> | undefined;

  let currentRunStartMs: number | undefined;
  let previousRunDurationMs: number | undefined;
  let longestRunDurationMs: number | undefined;

  let lastCtx: ExtensionContext | undefined;

  function getState(): TimerState {
    return {
      currentRunStartMs,
      previousRunDurationMs,
      longestRunDurationMs,
    };
  }

  function applyState(state: TimerState): void {
    currentRunStartMs = state.currentRunStartMs;
    previousRunDurationMs = state.previousRunDurationMs;
    longestRunDurationMs = state.longestRunDurationMs;
  }

  function saveState(): void {
    pi.appendEntry(STATE_TYPE, getState());
  }

  function restoreState(ctx: ExtensionContext): void {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== STATE_TYPE && entry.customType !== LEGACY_STATE_TYPE) continue;
      if (isTimerState(entry.data)) {
        applyState(entry.data);
      }
      return;
    }
  }

  function stopTimer(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  function startTimer(): void {
    stopTimer();
    // 运行期间每秒刷一次 footer，让计时文本跳动
    timer = setInterval(() => {
      if (!lastCtx?.hasUI) return;
      shared.requestRender?.();
    }, 1000);
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    stopTimer();
    restoreState(ctx);
    if (!ctx.hasUI) return;
    if (currentRunStartMs !== undefined) startTimer();
    shared.requestRender?.();
  });

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (!ctx.hasUI) return;

    if (currentRunStartMs === undefined) {
      currentRunStartMs = Date.now();
      startTimer();
    }

    shared.requestRender?.();
  });

  pi.on("agent_settled", (_event, ctx) => {
    lastCtx = ctx;
    if (!ctx.hasUI) {
      stopTimer();
      return;
    }
    if (currentRunStartMs === undefined) {
      shared.requestRender?.();
      return;
    }

    const duration = Date.now() - currentRunStartMs;
    previousRunDurationMs = duration;

    if (longestRunDurationMs === undefined || duration > longestRunDurationMs) {
      longestRunDurationMs = duration;
    }

    currentRunStartMs = undefined;
    stopTimer();
    saveState();
    shared.requestRender?.();
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    // 保存计时状态（persist 到 session），停掉 tick 定时器
    saveState();
    stopTimer();
    lastCtx = undefined;
  });

  return {
    getStatusText(theme: Theme): string {
      const startMs = currentRunStartMs;
      const working = startMs !== undefined;

      const elapsed = startMs !== undefined ? formatDuration(Date.now() - startMs) : "idle";
      const prev = previousRunDurationMs !== undefined ? formatDuration(previousRunDurationMs) : "--:--";
      const max = longestRunDurationMs !== undefined ? formatDuration(longestRunDurationMs) : "--:--";

      const indicator = working ? theme.fg("accent", "●") : theme.fg("dim", "○");
      const elapsedText = working ? theme.fg("text", elapsed) : theme.fg("dim", elapsed);
      const label = theme.fg("dim", " run ");
      const stats = theme.fg("dim", ` · prev ${prev} · max ${max}`);

      return `${indicator}${label}${elapsedText}${stats}`;
    },
  };
}
