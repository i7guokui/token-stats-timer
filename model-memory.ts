// model-memory 模块 —— 按工作目录记忆「最后一次手动切换的模型」
// =============================================================================
// 行为（默认开启，/auto-remember-model on|off 切换）：
//   - 用户手动切换模型（/model 选择、Ctrl+P 循环等 model_select set/cycle）
//     时，以当前 cwd 为 key 记录 { provider, modelId, at }
//   - 新开会话（CLI 启动的空白会话 / 会话内 /new）若初始模型正是 pi 的
//     全局默认模型，则自动 setModel 切换到该目录记忆的模型；
//     若没有记忆 / 记忆模型已失效 / 初始模型不是默认模型（如 --model /
//     --models 显式指定），则保持 pi 原行为（用默认模型或显式模型）
//   - 恢复会话（--continue / --resume / 切换）不干预：仍恢复会话自身最后
//     使用的模型（与 pi 原生行为一致）
//
// 与 thinking-memory（按模型记思考强度）互不冲突：本模块只切模型，切模型
// 触发的 model_select 会照常让 thinking-memory 应用目标模型的思考强度。
//
// 配置：~/.pi/agent/extensions/token-stats/model-memory.json
//   {
//     "enabled": true,
//     "cwdModels": {
//       "/path/to/project": { "provider": "cmd", "modelId": "deepseek/deepseek-v4-pro", "at": 1725... }
//     }
//   }

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { t } from "./user-language.ts";

/** 事件型 vs 存储型 key：模型统一用 `${provider}/${modelId}` 字符串 */
interface CwdModelMemory {
  provider: string;
  modelId: string;
  /** 记录时间(epoch ms)，用于展示 */
  at: number;
}

interface ModelMemoryConfig {
  enabled: boolean;
  /** key: cwd（规范化绝对路径） */
  cwdModels: Record<string, CwdModelMemory>;
}

interface EffectiveDefaultModel {
  provider: string;
  modelId: string;
}

const EXTENSION_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
const CONFIG_FILE = join(EXTENSION_DIR, "model-memory.json");

const DEFAULT_CONFIG: ModelMemoryConfig = { enabled: true, cwdModels: {} };

/** 归一化 cwd（绝对化 + 去尾部斜杠），保证记录/读取 key 一致 */
function normCwd(cwd: string): string {
  return resolve(cwd);
}

/** 会触发"新会话用默认模型"的 session_start 原因 */
const FRESH_SESSION_REASONS = new Set<string>(["startup", "new"]);

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------
function loadConfig(): ModelMemoryConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG, cwdModels: {} };
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as unknown;
    const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const cwdModels: Record<string, CwdModelMemory> = {};
    const stored = cfg.cwdModels;
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [cwd, value] of Object.entries(stored as Record<string, unknown>)) {
        const v = value as Record<string, unknown>;
        if (
          v &&
          typeof v === "object" &&
          typeof v.provider === "string" &&
          typeof v.modelId === "string"
        ) {
          cwdModels[cwd] = {
            provider: v.provider,
            modelId: v.modelId,
            at: typeof v.at === "number" ? v.at : 0,
          };
        }
      }
    }
    return { enabled: cfg.enabled !== false, cwdModels };
  } catch {
    return { ...DEFAULT_CONFIG, cwdModels: {} };
  }
}

function saveConfig(cfg: ModelMemoryConfig): void {
  mkdirSync(EXTENSION_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// pi 默认模型解析（与 pi 相同的合并规则：project settings 覆盖 global）
// ---------------------------------------------------------------------------
function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir.replace(/^~(?=\/|$)/, homedir());
  return join(homedir(), ".pi", "agent");
}

function parseSettingsFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 读取当前生效的默认模型（global ~/.pi/agent/settings.json + 项目 .pi/settings.json 合并）。
 *  无默认模型时返回 undefined（此时不启用自动切换）。 */
function readEffectiveDefaultModel(cwd: string): EffectiveDefaultModel | undefined {
  const globalSettings = parseSettingsFile(join(resolveAgentDir(), "settings.json"));
  const projectSettings = parseSettingsFile(join(normCwd(cwd), ".pi", "settings.json"));

  const provider =
    (typeof projectSettings.defaultProvider === "string" && projectSettings.defaultProvider) ||
    (typeof globalSettings.defaultProvider === "string" && globalSettings.defaultProvider) ||
    undefined;
  const modelId =
    (typeof projectSettings.defaultModel === "string" && projectSettings.defaultModel) ||
    (typeof globalSettings.defaultModel === "string" && globalSettings.defaultModel) ||
    undefined;
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

// ---------------------------------------------------------------------------
// 模型 key 工具
// ---------------------------------------------------------------------------
function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function formatModelLabel(m: CwdModelMemory): string {
  return `${m.provider}/${m.modelId}`;
}

// ---------------------------------------------------------------------------
// 模块入口
// ---------------------------------------------------------------------------
export function createModelMemory(pi: ExtensionAPI): void {
  let cfg = loadConfig();

  /** 最近一次自动切换（来源标记，防止被误判为用户手动切换而覆盖记忆——虽然值相同无害） */
  let lastAutoApply: { at: number; key: string } | null = null;

  /** 记录一次模型选择（仅用户主动：model_select 的 set/cycle） */
  function remember(cwd: string, provider: string, modelId: string): void {
    if (!cfg.enabled) return;
    const key = normCwd(cwd);
    const existing = cfg.cwdModels[key];
    if (existing && existing.provider === provider && existing.modelId === modelId) {
      // 值相同仅刷新时间，避免重复写盘
      existing.at = Date.now();
      saveConfig(cfg);
      return;
    }
    cfg = {
      ...cfg,
      cwdModels: {
        ...cfg.cwdModels,
        [key]: { provider, modelId, at: Date.now() },
      },
    };
    saveConfig(cfg);
  }

  /** 忘掉指定 cwd 的记忆（/auto-remember-model forget） */
  function forget(cwd: string): boolean {
    const key = normCwd(cwd);
    if (!cfg.cwdModels[key]) return false;
    const next = { ...cfg.cwdModels };
    delete next[key];
    cfg = { ...cfg, cwdModels: next };
    saveConfig(cfg);
    return true;
  }

  /**
   * 新会话自动应用记忆模型（仅当初始模型就是 pi 全局默认模型时）。
   * 通过 ctx.modelRegistry 解析模型对象后调用 pi.setModel，扩展自身不持有
   * 过期的 Model 引用（模型目录刷新后 id 仍能重新解析）。
   */
  async function applyForCwd(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    if (!cfg.enabled) return;
    if (!FRESH_SESSION_REASONS.has(event.reason)) return;

    const cwd = normCwd(ctx.cwd);
    if (!cwd) return;

    // 该会话是否已有消息（--continue/--resume/--session/fork 载入历史后
    // session_start 也带 startup 原因；有消息即"恢复会话"，pi 已按其自身
    // 记录恢复模型，不干预）
    const branch = ctx.sessionManager.getBranch();
    if (branch.some((entry) => entry.type === "message")) return;

    const remembered = cfg.cwdModels[cwd];
    if (!remembered) return;

    const current = ctx.model;
    if (!current) return;

    // 仅当初始模型是 pi 生效默认模型时才自动切（尊重 --model/--models）
    const effectiveDefault = readEffectiveDefaultModel(cwd);
    if (!effectiveDefault) return;
    if (!(current.provider === effectiveDefault.provider && current.id === effectiveDefault.modelId)) {
      return;
    }

    const rememberedKey = modelKey(remembered.provider, remembered.modelId);
    if (modelKey(current.provider, current.id) === rememberedKey) return;

    // 解析记忆模型对象；找不到（目录更新/模型下架）则忽略，保持默认
    const target = ctx.modelRegistry.find(remembered.provider, remembered.modelId);
    if (!target) return;

    lastAutoApply = { at: Date.now(), key: rememberedKey };
    try {
      const ok = await pi.setModel(target);
      if (!ok) lastAutoApply = null; // 无 auth，未实际切换
    } catch {
      lastAutoApply = null;
      // setModel 失败不阻塞启动
    }
  }

  pi.registerCommand("auto-remember-model", {
    description: t(
      "按目录记忆上次切换的模型: on | off | forget（无参查看状态）",
      "Remember last model per working dir: on | off | forget (no arg shows status)",
    ),
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      if (typeof argumentPrefix !== "string") return null;
      const prefix = argumentPrefix.trim().toLowerCase();
      const matches = ["on", "off", "forget"]
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
            `按目录记忆模型已${arg === "on" ? "开启" : "关闭"}`,
            `Remember-model-per-dir ${arg === "on" ? "enabled" : "disabled"}`,
          ),
          "info",
        );
        return;
      }
      if (arg === "forget") {
        const removed = forget(ctx.cwd);
        ctx.ui.notify(
          removed
            ? t("已清除当前目录的模型记忆", "Cleared model memory for this directory")
            : t("当前目录没有模型记忆", "No model memory for this directory"),
          removed ? "info" : "warning",
        );
        return;
      }
      // 无参：查看状态
      const remembered = cfg.cwdModels[normCwd(ctx.cwd)];
      if (!cfg.enabled) {
        ctx.ui.notify(t("按目录记忆模型: 关", "Remember-model-per-dir: off"), "info");
      } else if (remembered) {
        const at = remembered.at
          ? new Date(remembered.at).toLocaleString()
          : "";
        ctx.ui.notify(
          t(
            `按目录记忆模型: 开 · 本目录: ${formatModelLabel(remembered)}${at ? ` (${at})` : ""}`,
            `Remember-model-per-dir: on · this dir: ${formatModelLabel(remembered)}${at ? ` (${at})` : ""}`,
          ),
          "info",
        );
      } else {
        ctx.ui.notify(
          t("按目录记忆模型: 开 · 本目录尚无记忆（新会话将用默认模型）", "Remember-model-per-dir: on · no memory for this dir yet"),
          "info",
        );
      }
    },
  });

  // 用户手动切换模型 → 记录到当前 cwd
  pi.on("model_select", (event, ctx) => {
    // source 目前只会是 set/cycle（恢复会话不触发 model_select），
    // 保留 restore 分支以防未来版本恢复也发事件
    if (event.source === "restore") return;
    // 忽略自身在 session_start 自动切换产生的记录（值相同，不影响语义）
    if (lastAutoApply && Date.now() - lastAutoApply.at < 500 && modelKey(event.model.provider, event.model.id) === lastAutoApply.key) {
      lastAutoApply = null;
      return;
    }
    lastAutoApply = null;
    remember(ctx.cwd, event.model.provider, event.model.id);
  });

  // 新会话（startup 空白 / new）若初始为默认模型 → 应用该目录记忆
  pi.on("session_start", (event: SessionStartEvent, ctx) => {
    // await 保证在用户输入/首轮请求前完成；内部已 try/catch，不会抛错阻塞
    return applyForCwd(event, ctx);
  });
}
