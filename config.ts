// config —— 统一配置文件（所有模块共用一份 JSON）
// =============================================================================
// 把原先分散的 5 个配置文件合并成一个：
//   ~/.pi/agent/extensions/token-stats/config.json
//
//   {
//     "token":    { providerPlans, ttl, teamCredential },   // 原 config.json
//     "display":  { items, contextStyle, speedStyle },      // 原 display-config.json
//     "notify":   { enabled, minDurationSec, sound, ... },  // 原 notify-config.json
//     "thinking": { enabled, levels },                      // 原 auto-remember-thinking-level.json
//     "model":    { enabled, cwdModels }                    // 原 model-memory.json
//   }
//
// 关键设计：**单一内存副本 + 按 section 写入**
//   多个模块都会写配置（token/display/notify/thinking/model），若各自
//   read-modify-write 同一个文件，后写者会覆盖前者的 section。
//   因此这里只保留一份内存副本，任何 save 都先更新内存再整体落盘，
//   天然避免并发覆盖。
//
// 本模块只负责**存储**：读写 JSON、迁移旧文件。各 section 的类型校验与
// 默认值合并仍由使用方（notify/thinking-memory/model-memory/token-stats）负责。
//
// 旧格式自动迁移：首次读取时若发现旧的散装文件，合并进内存并备份为 *.bak。

import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".pi/agent/extensions/token-stats");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** 统一配置的 section 名（同时也是旧版散装文件名的一部分） */
export type SectionName = "token" | "display" | "notify" | "thinking" | "model";

/**
 * 旧版散装文件 → section 的映射。
 * 注意 token 的旧文件名与新的统一文件名相同（都是 config.json），
 * 因此迁移时需要靠**内容结构**判断是旧格式还是新格式。
 */
const LEGACY_FILES: Record<SectionName, string> = {
  token: "config.json",
  display: "display-config.json",
  notify: "notify-config.json",
  thinking: "auto-remember-thinking-level.json",
  model: "model-memory.json",
};

const ALL_SECTIONS: SectionName[] = ["token", "display", "notify", "thinking", "model"];

/** 读 JSON，失败或非对象返回 undefined（不抛异常） */
function readJsonSafe(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 判断 config.json 的内容是「新统一格式」还是「旧 token 单一格式」。
 *   旧格式顶层键：providerPlans / ttl / teamCredential
 *   新格式顶层键：token / display / notify / thinking / model
 */
function isLegacyTokenConfig(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  // 出现任一 section 名 → 已是新格式
  if (keys.some((k) => (ALL_SECTIONS as string[]).includes(k))) return false;
  // 含旧 token 的顶层键 → 旧格式
  return keys.some((k) => k === "providerPlans" || k === "ttl" || k === "teamCredential");
}

/** 把旧文件重命名为 *.bak（已有 .bak 则保留，不覆盖上一次备份） */
function backupLegacy(name: string): void {
  const from = join(CONFIG_DIR, name);
  const to = join(CONFIG_DIR, `${name}.bak`);
  try {
    if (!existsSync(from) || existsSync(to)) return;
    renameSync(from, to);
  } catch {
    // 备份失败不影响启动（旧文件仍在，下次启动再试）
  }
}

// ── 单例状态 ─────────────────────────────────────────────

let cache: Record<string, unknown> | null = null;

/** 落盘：把整份内存副本写回统一文件 */
function writeConfig(): void {
  if (!cache) return;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

/**
 * 迁移旧版散装配置 → 统一格式，并备份旧文件。
 * @param existingToken 旧 config.json 的原始内容（若它确实是旧 token 格式）
 */
function migrateLegacy(existingToken: Record<string, unknown> | undefined): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // token section 来自旧 config.json 本体
  if (existingToken) config.token = existingToken;

  // 其余 section 来自各自的旧文件
  for (const section of ALL_SECTIONS) {
    if (section === "token") continue;
    const data = readJsonSafe(join(CONFIG_DIR, LEGACY_FILES[section]));
    if (data) config[section] = data;
  }

  // 先写回统一文件（复用 config.json 路径），再备份其余旧文件。
  // config.json 本身无法备份成 .bak 后再写同名文件，故单独先备份。
  mkdirSync(CONFIG_DIR, { recursive: true });
  const legacyBackup = join(CONFIG_DIR, "config.json.bak");
  try {
    if (existsSync(CONFIG_FILE) && !existsSync(legacyBackup)) {
      // 保留旧 token 配置原文，便于回滚（内含 GLM 团队凭证等敏感信息）
      writeFileSync(legacyBackup, readFileSync(CONFIG_FILE, "utf-8"), "utf-8");
    }
  } catch {
    // 备份失败不阻塞迁移
  }

  for (const section of ALL_SECTIONS) {
    if (section === "token") continue; // 已单独处理
    backupLegacy(LEGACY_FILES[section]);
  }

  return config;
}

/**
 * 载入配置（每进程只读盘一次）。
 * 首次调用时若发现旧格式，会自动迁移 + 备份。
 */
export function loadConfig(): Record<string, unknown> {
  if (cache) return cache;

  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = readJsonSafe(CONFIG_FILE);

  if (existing && !isLegacyTokenConfig(existing)) {
    // 已是新统一格式
    cache = existing;
    return cache;
  }

  // 旧格式（或文件不存在）：迁移
  cache = migrateLegacy(existing);
  writeConfig();
  return cache;
}

/**
 * 读取某个 section。
 * 返回值是内存中的引用，调用方请勿直接修改；改动请走 saveSection。
 */
export function getSection<T>(name: SectionName): T | undefined {
  return loadConfig()[name] as T | undefined;
}

/**
 * 覆盖写入某个 section 并落盘。
 * 因为共享同一份内存副本，不会覆盖其它 section。
 */
export function saveSection<T>(name: SectionName, value: T): void {
  const cfg = loadConfig();
  cfg[name] = value;
  writeConfig();
}

/** 仅供测试：丢弃内存缓存，强制下次重新读盘 */
export function resetConfigCache(): void {
  cache = null;
}
