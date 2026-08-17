// step-timer 模块 —— 每步耗时(思考/工具/回复)+ 每 turn / 总耗时会话摘要
// =============================================================================
// 实时显示(仅交互 TUI):
//   - 任务执行中:工作指示器文案改为 "Working... 01:02"(整体已耗时,每秒刷新)
//   - 思考阶段:隐藏思考块文案改为 "Thinking... 00:45"(当前思考块已耗时)
// 会话摘要(appendEntry 持久化,不进入 LLM 上下文):
//   - 每个 turn 结束 appendEntry("timing-turn", …):该 turn 思考/工具/回复分项
//   - agent_settled  appendEntry("timing-final", …):总耗时 + 思考占比 + 各工具统计
//
// 一次 run = 空闲后的首个 agent_start → agent_settled(与 run-timer 语义一致,
// 包含重试、压缩恢复和排队的 steering/follow-up 提示)。

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export type StepPhase = "idle" | "thinking" | "text" | "tool";

/** 单个工具的聚合统计(当前 turn 内按工具名累计) */
export interface ToolStat {
  name: string;
  count: number;
  totalMs: number;
  errors: number;
}

/** 一个 turn 的耗时明细(appendEntry "timing-turn") */
export interface TurnTimingData {
  turnIndex: number;
  thinkingMs: number;
  textMs: number;
  tools: ToolStat[];
  totalMs: number;
}

/** 一次 run 的总耗时汇总(appendEntry "timing-final") */
export interface FinalTimingData {
  totalMs: number;
  thinkingMs: number;
  thinkingPct: number;
  textMs: number;
  tools: ToolStat[];
  turnCount: number;
  failed: boolean;
  aborted: boolean;
}

export type { ExtensionContext };

const TURN_TYPE = "timing-turn";
const FINAL_TYPE = "timing-final";
const TICK_MS = 1000;
const MAX_TOOLS_SHOWN = 4;

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

function mergeToolStat(a: Map<string, ToolStat>, b: ToolStat[]): void {
  for (const t of b) {
    const cur = a.get(t.name) ?? { name: t.name, count: 0, totalMs: 0, errors: 0 };
    cur.count += t.count;
    cur.totalMs += t.totalMs;
    cur.errors += t.errors;
    a.set(t.name, cur);
  }
}

function toolListText(tools: ToolStat[]): string {
  if (tools.length === 0) return "";
  const sorted = [...tools].sort((x, y) => y.totalMs - x.totalMs).slice(0, MAX_TOOLS_SHOWN);
  const parts = sorted.map((t) => `${t.name}×${t.count} ${formatDuration(t.totalMs)}`);
  if (tools.length > MAX_TOOLS_SHOWN) {
    parts.push(`…+${tools.length - MAX_TOOLS_SHOWN}个`);
  }
  return parts.join(" ");
}

/** “思考 00:45 (54%)” 这类分项；为 0 时省略 */
function segmentText(label: string, ms: number, withPct?: number): string {
  if (ms <= 0) return "";
  const base = `${label} ${formatDuration(ms)}`;
  return withPct !== undefined ? `${base} (${withPct}%)` : base;
}

export function createStepTimer(pi: ExtensionAPI): void {
  let lastCtx: ExtensionContext | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  let runActive = false;
  let runStartMs = 0;
  let runFailed = false;
  let runAborted = false;

  // run 级聚合(供 timing-final 用)
  let runThinkingMs = 0;
  let runTextMs = 0;
  const runTools = new Map<string, ToolStat>();
  let appendedTurns = 0;

  // turn 局部状态
  let turnIndex = 0;
  let phase: StepPhase = "idle";
  let phaseStartMs = 0;
  let turnThinkingMs = 0;
  let turnTextMs = 0;
  const turnTools = new Map<string, ToolStat>();
  const activeTools = new Map<string, { name: string; startMs: number }>();
  // 自上次 turn_end 后是否有计时事件(agent_settled 时兜底结算未闭合的 turn)
  let turnDirty = false;

  // ---------- 内部工具 ----------

  function resetRun(): void {
    runThinkingMs = 0;
    runTextMs = 0;
    runTools.clear();
    appendedTurns = 0;
    turnIndex = 0;
    phase = "idle";
    phaseStartMs = Date.now();
    turnThinkingMs = 0;
    turnTextMs = 0;
    turnTools.clear();
    activeTools.clear();
    turnDirty = false;
    runFailed = false;
    runAborted = false;
  }

  /** 结算当前阶段的耗时(阶段切换 / turn 收口时调用) */
  function closePhase(now: number, next: StepPhase): void {
    if (phase === "thinking") {
      turnThinkingMs += now - phaseStartMs;
      if (lastCtx?.hasUI) lastCtx.ui.setHiddenThinkingLabel(); // 恢复默认 "Thinking..."
    } else if (phase === "text") {
      turnTextMs += now - phaseStartMs;
    }
    // "tool" 阶段耗时按 toolCallId 单独计时(activeTools)，不走阶段时钟
    phase = next;
    phaseStartMs = now;
  }

  function turnToolTotal(): number {
    let sum = 0;
    for (const t of turnTools.values()) sum += t.totalMs;
    return sum;
  }

  /** 结算并追加一条 timing-turn 条目 */
  function finishTurn(now: number): void {
    const tools = [...turnTools.values()];
    const totalMs = turnThinkingMs + turnTextMs + turnToolTotal();
    pi.appendEntry<TurnTimingData>(TURN_TYPE, {
      turnIndex,
      thinkingMs: turnThinkingMs,
      textMs: turnTextMs,
      tools,
      totalMs,
    });

    runThinkingMs += turnThinkingMs;
    runTextMs += turnTextMs;
    mergeToolStat(runTools, tools);
    appendedTurns++;

    turnThinkingMs = 0;
    turnTextMs = 0;
    turnTools.clear();
    turnDirty = false;
  }

  function updateLiveLabels(now: number): void {
    if (!lastCtx?.hasUI || !runActive) return;
    const ui = lastCtx.ui;
    ui.setWorkingMessage(`Working... ${formatDuration(now - runStartMs)}`);
    if (phase === "thinking") {
      ui.setHiddenThinkingLabel(
        `Thinking... ${formatDuration(turnThinkingMs + (now - phaseStartMs))}`,
      );
    }
  }

  function startTicker(): void {
    stopTicker();
    tick = setInterval(() => updateLiveLabels(Date.now()), TICK_MS);
  }

  function stopTicker(): void {
    if (!tick) return;
    clearInterval(tick);
    tick = undefined;
  }

  function buildFinal(now: number): FinalTimingData {
    if (phase !== "idle") closePhase(now, "idle");
    return {
      totalMs: now - runStartMs,
      thinkingMs: runThinkingMs,
      thinkingPct: Math.round((runThinkingMs / Math.max(1, now - runStartMs)) * 100),
      textMs: runTextMs,
      tools: [...runTools.values()],
      turnCount: appendedTurns,
      failed: runFailed,
      aborted: runAborted,
    };
  }

  function appendFinal(now: number): void {
    pi.appendEntry<FinalTimingData>(FINAL_TYPE, buildFinal(now));
  }

  // ---------- 事件 ----------

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
    resetRun();
    startTicker();
    updateLiveLabels(runStartMs);
  });

  pi.on("message_update", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    turnDirty = true;
    const ev = event.assistantMessageEvent;
    const now = Date.now();
    if (!ev) return;
    if (ev.type === "thinking_start") {
      if (phase !== "thinking") closePhase(now, "thinking");
    } else if (ev.type === "text_start") {
      if (phase !== "text") closePhase(now, "text");
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    turnDirty = true;
    const now = Date.now();
    if (phase !== "tool") closePhase(now, "tool");
    activeTools.set(event.toolCallId, { name: event.toolName, startMs: now });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    const now = Date.now();
    const active = activeTools.get(event.toolCallId);
    if (!active) return;
    activeTools.delete(event.toolCallId);
    const ms = now - active.startMs;
    const stat = turnTools.get(active.name) ?? {
      name: active.name,
      count: 0,
      totalMs: 0,
      errors: 0,
    };
    stat.count++;
    stat.totalMs += ms;
    if (event.isError) stat.errors++;
    turnTools.set(active.name, stat);
    turnDirty = true;
    if (activeTools.size === 0) closePhase(now, "idle");
  });

  pi.on("turn_start", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    turnIndex = event.turnIndex;
  });

  pi.on("turn_end", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    const now = Date.now();
    if (turnIndex !== event.turnIndex) turnIndex = event.turnIndex;
    closePhase(now, "idle");
    if (turnDirty) finishTurn(now);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!runActive) return;
    lastCtx = ctx;
    // 扫描消息找失败/中止信号(与 notify 一致,仅用于 final 摘要标记)
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
    const now = Date.now();
    closePhase(now, "idle");
    if (turnDirty) finishTurn(now);
    appendFinal(now);
    if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage(); // 恢复默认 "Working..."
    runActive = false;
    stopTicker();
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    // 会话提前结束(如 /exit 或崩溃):尽力补一条最终汇总
    if (runActive) {
      appendFinal(Date.now());
      runActive = false;
    }
    stopTicker();
    lastCtx = undefined;
  });

  // ---------- 会话摘要渲染 ----------

  pi.registerEntryRenderer<TurnTimingData>(TURN_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const segs: string[] = [`turn ${d.turnIndex}`, formatDuration(d.totalMs)];
    const thinking = segmentText("思考", d.thinkingMs);
    if (thinking) segs.push(thinking);
    const text = segmentText("回复", d.textMs);
    if (text) segs.push(text);
    const tools = toolListText(d.tools);
    if (tools) segs.push(tools);

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("dim", `⏱ ${segs.join(" · ")}`), 0, 0));
    if (_opts.expanded && d.tools.length > MAX_TOOLS_SHOWN) {
      const rest = [...d.tools]
        .sort((x, y) => y.totalMs - x.totalMs)
        .slice(MAX_TOOLS_SHOWN);
      for (const t of rest) {
        box.addChild(
          new Text(theme.fg("dim", `  ${t.name}×${t.count} ${formatDuration(t.totalMs)}`), 0, 0),
        );
      }
    }
    return box;
  });

  pi.registerEntryRenderer<FinalTimingData>(FINAL_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const title = d.failed
      ? theme.fg("error", "❌ 任务失败 总耗时")
      : d.aborted
        ? theme.fg("dim", "⏹ 任务中止 总耗时")
        : theme.fg("accent", "✅ 任务完成 总耗时");
    const segs: string[] = [formatDuration(d.totalMs)];
    const thinking = segmentText("思考", d.thinkingMs, d.thinkingPct);
    if (thinking) segs.push(thinking);
    const text = segmentText("回复", d.textMs);
    if (text) segs.push(text);
    const tools = toolListText(d.tools);
    if (tools) segs.push(tools);
    segs.push(`${d.turnCount} turns`);

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${title} ${theme.fg("dim", segs.join(" · "))}`, 0, 0));
    if (_opts.expanded && d.tools.length > MAX_TOOLS_SHOWN) {
      const rest = [...d.tools]
        .sort((x, y) => y.totalMs - x.totalMs)
        .slice(MAX_TOOLS_SHOWN);
      for (const t of rest) {
        box.addChild(
          new Text(theme.fg("dim", `  ${t.name}×${t.count} ${formatDuration(t.totalMs)}`), 0, 0),
        );
      }
    }
    return box;
  });
}