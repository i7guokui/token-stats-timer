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

/** 一次 run 的总耗时汇总(appendEntry "timing-final") */
export interface FinalTimingData {
  totalMs: number;
}

const FINAL_TYPE = "timing-final";
const TICK_MS = 1000;

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

export function createStepTimer(pi: ExtensionAPI): void {
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
    pi.appendEntry<FinalTimingData>(FINAL_TYPE, {
      totalMs: Date.now() - runStartMs,
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

  pi.registerEntryRenderer<FinalTimingData>(FINAL_TYPE, (entry, _opts, _theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const box = new Box(1, 1);
    box.addChild(new Text(`总耗时 ${formatDuration(d.totalMs)}`, 0, 0));
    return box;
  });
}