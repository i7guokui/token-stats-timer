// user-language 模块 —— 直接读环境变量判断语言，输出文案随语言切换
// =============================================================================
// 只检测环境变量：LC_ALL / LC_MESSAGES / LANG 任一以 zh 开头 → 中文，
// 否则一律英文。不做消息内容启发式判断。
//
// 使用：文案处用 t("中文", "English") 取当前语言版本；也可 getUserLanguage() 判断。

const LOCALE_ENV_VARS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

let current: "zh" | "en" = "en";

/** 读环境变量：任一 locale 变量以 zh 开头 → 中文，其余 → 英文 */
function detectFromEnv(): "zh" | "en" {
  for (const name of LOCALE_ENV_VARS) {
    const value = (process.env[name] || "").trim();
    if (value && /^zh/i.test(value)) return "zh";
  }
  return "en";
}

/** 当前推断的用户语言 */
export function getUserLanguage(): "zh" | "en" {
  return current;
}

/** 按当前语言取文案 */
export function t(zh: string, en: string): string {
  return current === "zh" ? zh : en;
}

/** 初始化：确定用户语言（当前仅由环境变量决定） */
export function createUserLanguage(): void {
  current = detectFromEnv();
}