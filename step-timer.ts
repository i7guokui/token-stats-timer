// step-timer 模块 —— 任务计时
// =============================================================================
// 实时显示(仅交互 TUI):
//   - 任务执行中:工作指示器文案显示 "Working... 01:02"(整体已耗时,每秒刷新)
// 逐条内联标注(每条 assistant 消息末尾自动追加一行):
//   - 例:`ai 回复内容...` 后另起一行 `> ⏱ 思考 00:05`
//   - 当前正在生成的消息:该行随流式内容实时更新(思考计时);消息提交后永久定格
//   - 历史消息各自保留提交时的耗时,互不影响、不再变化(标注已存在则跳过,resume 回放不显示)
//     (pi 的 hiddenThinkingLabel 文案是全局的、无法逐条保留,故改用内联标注)
// 完成后汇总(appendEntry 持久化,不进入 LLM 上下文,resume 后可回看):
//   - agent_settled  appendEntry("timing-final", …):本次任务总耗时
//
// 一次 run = 空闲后的首个 agent_start → agent_settled(与 run-timer 语义一致,
// 包含重试、压缩恢复和排队的 steering/follow-up 提示)。

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

  // 逐条内联标注:当前消息的思考计时(每条 assistant 消息开始时重置)
  // curThinkingMs:已结算的思考毫秒;thinkingStart:进行中思考块的起表时间
  let curThinkingMs = 0;
  let thinkingStart: number | undefined;

  /** 结算当前进行中的思考块(若有) */
  function settleThinking(now: number): void {
    if (thinkingStart !== undefined) {
      curThinkingMs += now - thinkingStart;
      thinkingStart = undefined;
    }
  }

  /** 当前消息的思考总耗时(含进行中块):有思考数据才显示 */
  function currentThinkingMs(now: number): number | undefined {
    if (curThinkingMs === 0 && thinkingStart === undefined) return undefined;
    return curThinkingMs + (thinkingStart !== undefined ? now - thinkingStart : 0);
  }

  const MARK_TEXT = "⏱ 思考";

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
    curThinkingMs = 0;
    thinkingStart = undefined;
    startTicker();
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage("Working... 00:00");
  });

  // 每条 assistant 消息开始时重置思考计时
  pi.on("message_start", (event, ctx) => {
    if (!runActive || event.message.role !== "assistant") return;
    lastCtx = ctx;
    curThinkingMs = 0;
    thinkingStart = undefined;
  });

  pi.on("message_update", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    const ev = event.assistantMessageEvent;
    if (!ev) return;
    const now = Date.now();
    if (ev.type === "thinking_start") {
      if (thinkingStart === undefined) thinkingStart = now;
    } else if (ev.type === "thinking_end" || ev.type === "text_start") {
      settleThinking(now);
    }
  });

  pi.on("tool_execution_start", (_event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    // 工具执行通常在同一消息的 toolCall 内容之后:结算思考计时
    settleThinking(Date.now());
  });

  pi.on("agent_end", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
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

  // ---------- 逐条内联标注 ----------
  // 只在 assistant 文本上追加一行耗时;已带标注(历史消息重渲染)则跳过保持原值
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant") return markdown;
    if (markdown.includes(MARK_TEXT)) return markdown;
    const now = Date.now();
    const ms = currentThinkingMs(now);
    if (ms === undefined) return markdown;
    return `${markdown}\n\n> ${MARK_TEXT} ${formatDuration(ms)}`;
  });

  pi.registerEntryRenderer<FinalTimingData>(FINAL_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const title = theme.fg("accent", "总耗时");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${title} ${formatDuration(d.totalMs)}`, 0, 0));
    return box;
  });
}