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
//   onSuccess / onAbort / onSessionEnd  各类通知开关
//
// 命令：/notify on | off | status | test
//
// ── 投递通道（按优先级自动降级）──────────────────────────────
//   1. OSC 终端协议：向 stdout 写转义序列，由终端自己弹系统通知，归属终端应用。
//      ⚠️ 重要：iTerm2 官方文档的通知序列是 OSC 9（`ESC]9;msg`）！
//         OSC 777 是 rxvt 系/Ghostty/WezTerm 用的，iTerm2 3.6.9 才支持，
//         iTerm2 3.5.x 收到 OSC 777 会静默忽略（实测确认）。
//      - iTerm2 → OSC 9（无标题字段，格式为 `标题\n内容`）
//      - Ghostty / WezTerm / Hyper / rxvt-unicode → OSC 777（title;body）
//   2. terminal-notifier：brew install terminal-notifier 装了之后用它，
//      系统级最可靠，-sender 指定归属 bundle id，-group 去重。
//   3. osascript：保底（无法用终端协议时的最后手段）。
//
// 每次投递结果追加到 ~/.pi/agent/extensions/token-stats-logs/notify.log，
// 便于排查"没弹通知"是触发问题还是投递问题。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./user-language.ts";

const CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const CONFIG_FILE = join(CONFIG_DIR, "notify-config.json");

/** 支持 OSC 777 终端协议的应用（按 TERM_PROGRAM 匹配） */
const OSC777_TERMINALS = new Set([
  "iTerm.app",
  "iTerm2",
  "WezTerm",
  "WezTerm.app",
  "ghostty",
  "Ghostty",
  "Hyper",
]);

export interface NotifyConfig {
  enabled: boolean;
  minDurationSec: number;
  sound: string;
  onSuccess: boolean;
  onAbort: boolean;
  onSessionEnd: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  minDurationSec: 0,
  sound: "Glass",
  onSuccess: true,
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

/** 终端是否支持 OSC 777 通知协议（非 iTerm2 的现代终端：Ghostty/WezTerm/Hyper/rxvt） */
function supportsOSC777(): boolean {
  const tp = process.env.TERM_PROGRAM || "";
  if (OSC777_TERMINALS.has(tp)) return true;
  // rxvt-unicode 系列仅能从 TERM 判断
  return /rxvt|urxvt/i.test(process.env.TERM || "");
}

/** 是否 iTerm2（iTerm2 官方文档的通知序列是 OSC 9，不是 OSC 777） */
function isITerm2(): boolean {
  const tp = process.env.TERM_PROGRAM || "";
  return tp === "iTerm.app" || tp === "iTerm2";
}

/** 通道1a：OSC 9 终端通知（iTerm2 官方文档序列，无标题字段，格式 `标题\n内容`） */
function notifyOSC9(title: string, message: string): void {
  const safe = (s: string) => s.replace(/[\x07\x1b]/g, "").replace(/;/g, "·");
  process.stdout.write(`\x1b]9;${safe(title)}\n${safe(message)}\x07`);
}

/** 通道1b：OSC 777 终端通知（Ghostty / WezTerm / Hyper / rxvt，title;body 结构） */
function notifyOSC777(title: string, message: string): void {
  // 去掉 BEL/ESC 等可能截断/注入的字符；OSC 参数以 ; 分隔，替换为 · 避免歧义
  const safe = (s: string) => s.replace(/[\x07\x1b]/g, "").replace(/;/g, "·");
  process.stdout.write(`\x1b]777;notify;${safe(title)};${safe(message)}\x07`);
}

/** 通道2：terminal-notifier（brew 安装后自动使用），-sender 归属终端保证权限生效 */
function notifyTerminalNotifier(title: string, message: string, sound: string): boolean {
  const candidates = [
    "/opt/homebrew/bin/terminal-notifier",
    "/usr/local/bin/terminal-notifier",
  ];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) return false;

  const sender =
    process.env.TERM_PROGRAM === "iTerm.app"
      ? "com.googlecode.iterm2"
      : process.env.TERM_PROGRAM === "WezTerm"
        ? "org.wezfurlong.wezterm"
        : undefined;
  const args = ["-title", title, "-message", message, "-group", "pi-agent"];
  if (sound) args.push("-sound", sound);
  if (sender) args.push("-sender", sender);

  try {
    const r = spawnSync(exe, args, { timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/** 通道3：osascript 保底（不支持 OSC 777 的终端） */
function notifyOSAScript(title: string, message: string, sound: string): void {
  const soundPart = sound ? ` sound name ${JSON.stringify(sound)}` : "";
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${soundPart}`;
  const child = spawn("osascript", ["-e", script], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.unref();
}

export function createNotifier(pi: ExtensionAPI): void {
  let config: NotifyConfig = loadConfig();

  // 当前 run 的状态（agent_start 重置，agent_end 收集，agent_settled 消费）
  let runStartMs: number | undefined;
  let runAborted = false;

  // 进程内去抖计时
  let lastNotifyAt = 0;

  /** 多通道投递：iTerm2 用 OSC 9 → 其他终端 OSC 777 → terminal-notifier → osascript */
  function notify(title: string, message: string, sound: string): void {
    if (process.platform !== "darwin") return; // 非 macOS 直接跳过

    const now = Date.now();
    if (now - lastNotifyAt < DEBOUNCE_MS) return;
    lastNotifyAt = now;

    if (isITerm2()) {
      // iTerm2：官方文档通知序列 OSC 9（实测有效）
      notifyOSC9(title, message);
      return;
    }

    if (supportsOSC777()) {
      // Ghostty / WezTerm / Hyper / rxvt：OSC 777
      notifyOSC777(title, message);
      return;
    }

    if (notifyTerminalNotifier(title, message, sound)) {
      return;
    }

    notifyOSAScript(title, message, sound);
  }

  pi.on("agent_start", () => {
    runAborted = false;
    if (runStartMs === undefined) runStartMs = Date.now();
  });

  // 一次 run 结束；若 run 已带错误状态，最终结论按错误弹
  pi.on("agent_end", (event) => {
    if (!config.enabled) return;
    for (const m of event.messages) {
      if (m.role === "assistant") {
        if (m.stopReason === "aborted") {
          runAborted = true;
        }
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

    const dur = startMs !== undefined ? `${formatDuration(durationMs)}` : "-";

    if (runAborted) {
      if (config.onAbort) {
        notify(
          t("⏹ pi 已中止", "⏹ pi aborted"),
          t(`耗时：${dur}`, `Duration: ${dur}`) +
            `\n${truncate(t("执行被中止", "Execution aborted"))}`,
          config.sound,
        );
      }
    } else if (config.onSuccess) {
      notify(
        t("✅ pi 执行完成", "✅ pi task finished"),
        t(`耗时：${dur}`, `Duration: ${dur}`),
        config.sound,
      );
    }

    // 消费本次结果，避免串扰下一次 run
    runAborted = false;
  });

  // 会话关闭时提示（可选）
  pi.on("session_shutdown", () => {
    if (config.enabled && config.onSessionEnd) {
      notify(t("👋 pi 会话结束", "👋 pi session ended"), t("session 已关闭", "Session closed"), config.sound);
    }
  });

  // ── /notify 命令 ─────────────────────────────────────
  pi.registerCommand("notify", {
    description: t(
      "macOS 完成通知: on | off | status | test（详细配置见 notify-config.json）",
      "macOS completion notifications: on | off | status | test (see notify-config.json)",
    ),
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      if (typeof argumentPrefix !== "string") return null;
      const prefix = argumentPrefix.trim().toLowerCase();
      const values = ["on", "off", "status", "test"];
      const matches = values
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on") {
        config = { ...config, enabled: true };
        saveConfig(config);
        ctx.ui.notify(t("完成通知已开启", "Completion notifications enabled"), "info");
      } else if (arg === "off") {
        config = { ...config, enabled: false };
        saveConfig(config);
        ctx.ui.notify(t("完成通知已关闭", "Completion notifications disabled"), "info");
      } else if (arg === "test") {
        // 立即发一条测试通知，验证当前投递通道是否可达
        const title = t("🔔 pi 通知测试", "🔔 pi notification test");
        const channel = isITerm2()
          ? t("osc9 终端协议", "osc9 terminal protocol")
          : supportsOSC777()
            ? t("osc777 终端协议", "osc777 terminal protocol")
            : existsSync("/opt/homebrew/bin/terminal-notifier") ||
              existsSync("/usr/local/bin/terminal-notifier")
              ? "terminal-notifier"
              : "osascript";
        notify(
          title,
          t(`投递通道：${channel}\n时间：${new Date().toLocaleTimeString()}`, 
            `Channel: ${channel}\nTime: ${new Date().toLocaleTimeString()}`),
          config.sound,
        );
        ctx.ui.notify(t("测试通知已发送，请查看系统通知栏", "Test notification sent, check Notification Center"), "info");
      } else {
        const sound = config.sound
          ? t(`, 声音=${config.sound}`, `, sound=${config.sound}`)
          : t(", 静音", ", silent");
        ctx.ui.notify(
          t(
            `完成通知: ${config.enabled ? "开" : "关"}, 最短时长=${config.minDurationSec}s, ` +
              `成功=${config.onSuccess ? "开" : "关"}, ` +
              `中止=${config.onAbort ? "开" : "关"}, 会话结束=${config.onSessionEnd ? "开" : "关"}${sound}`,
            `Notifications: ${config.enabled ? "on" : "off"}, min duration=${config.minDurationSec}s, ` +
              `success=${config.onSuccess ? "on" : "off"}, ` +
              `abort=${config.onAbort ? "on" : "off"}, session end=${config.onSessionEnd ? "on" : "off"}${sound}`,
          ),
          "info",
        );
      }
    },
  });
}