// run-token-stats / notify 模块
// =============================================================================
// macOS 系统通知：每次 run（agent 完成任务）结束后弹系统通知，区分成功/失败/中止。
//
// run 语义与 run-timer 一致：从空闲后的第一个 agent_start 到 agent_settled
// 的连续忙碌期（含重试、压缩恢复、排队提示）。
//
// 配置持久化：~/.pi/agent/extensions/token-stats/notify-config.json
//   enabled       总开关（默认 true）
//   minDurationSec 时长低于该秒数的 run 不通知（默认 0 = 每次都通知）
//   sound         通知声音（默认 "Glass"，"" 表示静音）
//   onSuccess / onFailure / onAbort / onSessionEnd  各类通知开关（默认全开）
//
// 命令：/notify on | off | status

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const CONFIG_FILE = join(CONFIG_DIR, "notify-config.json");

export interface NotifyConfig {
  enabled: boolean;
  minDurationSec: number;
  sound: string;
  onSuccess: boolean;
  onFailure: boolean;
  onAbort: boolean;
  onSessionEnd: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  minDurationSec: 0,
  sound: "Glass",
  onSuccess: true,
  onFailure: true,
  onAbort: false,
  onSessionEnd: false,
};

function loadConfig(): NotifyConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<NotifyConfig>;
    return { ...DEFAULT_CONFIG, ...saved };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg: NotifyConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

/** 连续两次通知的最短间隔（毫秒），防止并行 agent 结束时刷屏 */
const DEBOUNCE_MS = 3000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function cwdName(): string {
  const parts = process.cwd().split("/").filter(Boolean);
  return parts.pop() || process.cwd();
}

export function createNotifier(pi: ExtensionAPI): void {
  let config: NotifyConfig = loadConfig();

  // 当前 run 的状态（agent_start 重置，agent_end 收集，agent_settled 消费）
  let runStartMs: number | undefined;
  let runFailed = false;
  let runAborted = false;
  let runErrorMsg: string | undefined;

  // 进程内去抖计时
  let lastNotifyAt = 0;

  function notify(title: string, message: string, sound: string): void {
    if (process.platform !== "darwin") return; // 非 macOS 直接跳过

    const now = Date.now();
    if (now - lastNotifyAt < DEBOUNCE_MS) return;
    lastNotifyAt = now;

    // spawn + 参数数组传参，避免 shell 注入；detached + unref 不阻塞 pi
    const soundPart = sound ? ` sound name ${JSON.stringify(sound)}` : "";
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${soundPart}`;
    const child = spawn("osascript", ["-e", script], { detached: true });
    child.unref();
  }

  pi.on("agent_start", () => {
    runFailed = false;
    runAborted = false;
    runErrorMsg = undefined;
    if (runStartMs === undefined) runStartMs = Date.now();
  });

  // 一次 run 结束；若 run 已带错误状态，最终结论按错误弹
  pi.on("agent_end", (event) => {
    if (!config.enabled) return;
    for (const m of event.messages) {
      if (m.role === "assistant") {
        if (m.stopReason === "aborted") {
          runAborted = true;
          runErrorMsg = runErrorMsg || "被用户中止";
        } else if (m.stopReason === "error" || m.errorMessage) {
          runFailed = true;
          runErrorMsg = runErrorMsg || m.errorMessage || "模型调用出错";
        }
      } else if (m.role === "toolResult" && m.isError) {
        runFailed = true;
        const toolMsg = `工具 ${m.toolName} 执行失败`;
        runErrorMsg = runErrorMsg && !runErrorMsg.startsWith("工具 ")
          ? runErrorMsg
          : toolMsg;
      }
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle()) return;

    const startMs = runStartMs;
    runStartMs = undefined;
    if (!config.enabled) return;

    const durationMs = startMs !== undefined ? Date.now() - startMs : 0;
    if (durationMs < config.minDurationSec * 1000) return;

    const where = `「${cwdName()}」`;
    const dur = startMs !== undefined ? ` · ${formatDuration(durationMs)}` : "";

    if (runFailed && config.onFailure) {
      notify(
        "❌ pi 执行失败",
        `${where}${dur}\n${truncate(runErrorMsg || "未知错误")}`,
        config.sound,
      );
    } else if (runAborted && config.onAbort) {
      notify(
        "⏹ pi 已中止",
        `${where}${dur}\n${truncate(runErrorMsg || "执行被中止")}`,
        config.sound,
      );
    } else if (config.onSuccess) {
      notify(
        "✅ pi 执行完成",
        `${where}${dur}\nagent 任务已结束`,
        config.sound,
      );
    }

    // 消费本次结果，避免串扰下一次 run
    runFailed = false;
    runAborted = false;
    runErrorMsg = undefined;
  });

  // 会话关闭时提示（可选）
  pi.on("session_shutdown", () => {
    if (config.enabled && config.onSessionEnd) {
      notify("👋 pi 会话结束", "session 已关闭", config.sound);
    }
  });

  // ── /notify 命令 ─────────────────────────────────────
  pi.registerCommand("notify", {
    description: "macOS 完成通知: on | off | status（详细配置见 notify-config.json）",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on") {
        config = { ...config, enabled: true };
        saveConfig(config);
        ctx.ui.notify("完成通知已开启", "info");
      } else if (arg === "off") {
        config = { ...config, enabled: false };
        saveConfig(config);
        ctx.ui.notify("完成通知已关闭", "info");
      } else {
        const sound = config.sound ? `, 声音=${config.sound}` : ", 静音";
        ctx.ui.notify(
          `完成通知: ${config.enabled ? "开" : "关"}, 最短时长=${config.minDurationSec}s, ` +
            `成功=${config.onSuccess ? "开" : "关"}, 失败=${config.onFailure ? "开" : "关"}, ` +
            `中止=${config.onAbort ? "开" : "关"}, 会话结束=${config.onSessionEnd ? "开" : "关"}${sound}`,
          "info",
        );
      }
    },
  });
}