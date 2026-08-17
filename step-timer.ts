// step-timer 模块 —— 任务计时
// =============================================================================
// 实时显示(仅交互 TUI):
//   - 任务执行中:工作指示器文案显示 "Working... 01:02"(整体已耗时,每秒刷新)
//   - 思考阶段:隐藏思考块文案显示 "Thinking... 00:45"(当前思考块已耗时)
// 完成后汇总(appendEntry 持久化,不进入 LLM 上下文,resume 后可回看):
//   - agent_settled  appendEntry("timing-final", …):本次任务总耗时
//
// 一次 run = 空闲后的首个 agent_start → agent_settled(与 run-timer 语义一致,
// 包含重试、压缩恢复和排队的 steering/follow-up 提示)。
//
// 注意:早期版本曾用 "timing-turn" 每 turn 摘要,该渲染器已移除,
// 历史遗留的 timing-turn 条目因无渲染器而自动不再显示。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** 一次 run 的总耗时汇总(appendEntry "timing-final") */
export interface FinalTimingData {
  totalMs: number;
  failed: boolean;
  aborted: boolean;
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
  let runFailed = false;
  let runAborted = false;

  // 思考阶段状态(仅用于 Thinking... 文案计时)
  let thinkingSinceMs: number | undefined;

  /** 结束思考阶段并恢复默认 "Thinking..." 文案(若当前处于思考中) */
  function endThinking(): void {
    if (thinkingSinceMs === undefined) return;
    thinkingSinceMs = undefined;
    if (lastCtx?.hasUI) lastCtx.ui.setHiddenThinkingLabel();
  }

  function startTicker(): void {
    stopTicker();
    tick = setInterval(() => {
      if (!lastCtx?.hasUI || !runActive) return;
      const now = Date.now();
      const ui = lastCtx.ui;
      ui.setWorkingMessage(`Working... ${formatDuration(now - runStartMs)}`);
      if (thinkingSinceMs !== undefined) {
        ui.setHiddenThinkingLabel(`Thinking... ${formatDuration(now - thinkingSinceMs)}`);
      }
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
      failed: runFailed,
      aborted: runAborted,
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
    runFailed = false;
    runAborted = false;
    thinkingSinceMs = undefined;
    startTicker();
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage("Working... 00:00");
  });

  pi.on("message_update", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    const ev = event.assistantMessageEvent;
    if (!ev) return;
    const now = Date.now();
    if (ev.type === "thinking_start") {
      thinkingSinceMs = now;
      if (lastCtx?.hasUI) {
        lastCtx.ui.setHiddenThinkingLabel("Thinking... 00:00");
      }
    } else if (ev.type === "thinking_end" || ev.type === "text_start") {
      endThinking();
    }
  });

  pi.on("tool_execution_start", (_event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    // 工具执行时恢复正常文案,避免 Thinking 计时残留
    endThinking();
  });

  pi.on("agent_end", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    // 扫描消息找失败/中止信号,仅用于最终摘要素材
    for (const msg of event.messages ?? []) {
      if (msg.type === "assistant") {
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          if (msg.stopReason === "error") runFailed = true;
          else runAborted = true;
        }
        if (msg.errorMessage) runFailed = true;
      } else if (msg.type === "toolResult" && msg.isError) {
        runFailed = true;
      }
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    lastCtx = ctx;
    if (!runActive) return;
    endThinking();
    appendFinal();
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage(); // 恢复默认 "Working..."
    runActive = false;
    stopTicker();
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    // 会话提前结束(如 /exit 或崩溃):尽力补一条最终汇总
    if (runActive) {
      endThinking();
      appendFinal();
      runActive = false;
    }
    stopTicker();
    lastCtx = undefined;
  });

  pi.registerEntryRenderer<FinalTimingData>(FINAL_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const title = d.failed
      ? theme.fg("error", "❌ 任务失败 总耗时")
      : d.aborted
        ? theme.fg("dim", "⏹ 任务中止 总耗时")
        : theme.fg("accent", "✅ 任务完成 总耗时");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${title} ${formatDuration(d.totalMs)}`, 0, 0));
    return box;
  });
}