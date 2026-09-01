// thinking-memory 模块 —— 按模型自动记忆思考强度
// =============================================================================
// 行为（默认开启，/auto-remember-thinking-level on|off 切换）：
//   - 用户手动切换 thinking level 时，自动记录为当前模型的默认级别
//   - session_start / model_select 时自动应用该模型记忆的级别
//   - 扩展自身 setThinkingLevel 与模型切换引起的级别变化不会被误记录
//
// 配置：~/.pi/agent/extensions/token-stats/auto-remember-thinking-level.json
//   {
//     "enabled": true,
//     "levels": { "opencode-go/deepseek-v4-flash": "max" }
//   }
//
// 参考 @tifan/pi-preferred-thinking（手动设置命令）改为自动记忆模式：不提供
// 单独设置命令，以用户的实际切换行为作为记忆来源。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./user-language.ts";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

const CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const CONFIG_FILE = join(CONFIG_DIR, "auto-remember-thinking-level.json");

const VALID_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface ThinkingMemoryConfig {
  enabled: boolean;
  levels: Record<string, ThinkingLevel>;
}

const DEFAULT_CONFIG: ThinkingMemoryConfig = { enabled: true, levels: {} };

/** 判定「手动切换」的窗口：距模型切换多少毫秒内的级别变化视为切换引起 */
const MODEL_SWITCH_WINDOW_MS = 200;
/** 自身 apply 引起的级别变化要在多少毫秒内匹配上才算（防止残留标志误吞手动切换） */
const APPLY_WINDOW_MS = 100;

function loadConfig(): ThinkingMemoryConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG, levels: {} };
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as unknown;
    const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const levels: Record<string, ThinkingLevel> = {};
    const configured = cfg.levels;
    if (configured && typeof configured === "object" && !Array.isArray(configured)) {
      for (const [modelKey, level] of Object.entries(configured)) {
        if (typeof level === "string" && VALID_LEVELS.has(level as ThinkingLevel)) {
          levels[modelKey] = level as ThinkingLevel;
        }
      }
    }
    return { enabled: cfg.enabled !== false, levels };
  } catch {
    return { ...DEFAULT_CONFIG, levels: {} };
  }
}

function saveConfig(cfg: ThinkingMemoryConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export function createThinkingMemory(pi: ExtensionAPI): void {
  let cfg = loadConfig();

  // 自身 apply 的记录：apply 时间 + 目标级别，事件匹配且窗口内则视为自身引起
  let lastApply: { at: number; level: ThinkingLevel } | null = null;
  // 最近一次模型切换时间戳（判断级别变化是否由切模型/clamp 引起）
  let lastModelSwitchAt = 0;

  /** 应用当前模型的记忆级别（自身 setThinkingLevel 不会触发误记录） */
  function applyForModel(ctx: ExtensionContext): void {
    if (!cfg.enabled) return;
    if (!ctx.model) return;
    const modelKey = `${ctx.model.provider}/${ctx.model.id}`;
    const level = cfg.levels[modelKey];
    if (!level) return;
    if (pi.getThinkingLevel() === level) return;

    lastApply = { at: Date.now(), level };
    pi.setThinkingLevel(level);
  }

  pi.registerCommand("auto-remember-thinking-level", {
    description: t(
      "自动记忆思考强度: on | off（无参查看状态）",
      "Auto-remember thinking level: on | off (no arg shows status)",
    ),
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      if (typeof argumentPrefix !== "string") return null;
      const prefix = argumentPrefix.trim().toLowerCase();
      const matches = ["on", "off"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        cfg = { ...cfg, enabled: arg === "on" };
        saveConfig(cfg);
        ctx.ui.notify(
          t(
            `自动记忆思考强度已${arg === "on" ? "开启" : "关闭"}`,
            `Auto-remember thinking level ${arg === "on" ? "enabled" : "disabled"}`,
          ),
          "info",
        );
      } else {
        ctx.ui.notify(
          t(
            `自动记忆思考强度: ${cfg.enabled ? "开" : "关"}`,
            `Auto-remember thinking level: ${cfg.enabled ? "on" : "off"}`,
          ),
          "info",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    applyForModel(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    lastModelSwitchAt = Date.now();
    applyForModel(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (!cfg.enabled) return;
    if (!ctx.model) return;
    const level = event.level as ThinkingLevel;
    if (!VALID_LEVELS.has(level)) return;

    // 自身 apply（session_start / model_select 恢复记忆）引起的变化：忽略
    if (lastApply && Date.now() - lastApply.at < APPLY_WINDOW_MS && level === lastApply.level) {
      lastApply = null;
      return;
    }

    const modelKey = `${ctx.model.provider}/${ctx.model.id}`;
    // 模型切换时 level 变化先于 model_select 发出，故延迟确认：
    // 窗口内 lastModelSwitchAt 发生变化（发生了模型切换）则丢弃，防止误记录
    const switchedAtSnapshot = lastModelSwitchAt;
    setTimeout(() => {
      if (lastModelSwitchAt !== switchedAtSnapshot) return;
      if (cfg.levels[modelKey] === level) return;
      cfg = { ...cfg, levels: { ...cfg.levels, [modelKey]: level } };
      saveConfig(cfg);
    }, MODEL_SWITCH_WINDOW_MS);
  });
}