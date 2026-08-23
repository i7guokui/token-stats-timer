// user-language 模块 —— 自动判断用户中英文，输出文案随语言切换
// =============================================================================
// pi 没有内置的用户语言信息（无 locale/language API/settings 字段），
// 采用启发式判断：
//   1. LANG 环境变量初始化（zh* → 中文，其余 → 英文）
//   2. 监听 message_start 的 user 消息，滑动窗口（最近 10 条）统计
//      每条消息的 CJK 汉字占比：≥50% 消息判定为中文 → 总语言切到中文
// 判错时窗口会随后续消息自动纠偏；样本为零时保持 LANG 初始猜测。
//
// 使用：文案处用 t("中文", "English") 取当前语言版本。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 滑动窗口大小（用户消息条数） */
const WINDOW_SIZE = 10;
/** 单条消息汉字占（汉字+英文字母）比例 ≥ 该值时判定为中文 */
const CJK_RATIO_THRESHOLD = 0.2;
/** 窗口内中文消息占比 ≥ 50% 时总语言取中文 */
const ZH_MAJORITY = 0.5;

let current: "zh" | "en" = "en";
let samples: ("zh" | "en")[] = [];

/** LANG 环境变量初始猜测：zh_* → 中文，其余 → 英文 */
function guessFromLang(): "zh" | "en" {
  const lang = (process.env.LANG || "").trim();
  return /^zh/i.test(lang) ? "zh" : "en";
}

/**
 * 单条文本的语言判定：按 CJK 汉字与英文字母的相对占比。
 * 无有效特征（空/纯数字/纯标点/纯符号）时返回 undefined（不参与统计）。
 */
export function detectLanguage(text: string): "zh" | "en" | undefined {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const asciiLetters = (text.match(/[A-Za-z]/g) ?? []).length;
  const meaningful = cjk + asciiLetters;
  if (meaningful === 0) return undefined;
  return cjk / meaningful >= CJK_RATIO_THRESHOLD ? "zh" : "en";
}

/** 当前推断的用户语言 */
export function getUserLanguage(): "zh" | "en" {
  return current;
}

/** 按当前语言取文案 */
export function t(zh: string, en: string): string {
  return current === "zh" ? zh : en;
}

/** 从 message.content 提取纯文本（兼容 string 与 content 块数组） */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c && typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join(" ");
  }
  return "";
}

export function createUserLanguage(pi: ExtensionAPI): void {
  current = guessFromLang();
  samples = [];

  pi.on("message_start", (event) => {
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const lang = detectLanguage(contentText(msg.content));
    if (!lang) return;

    samples.push(lang);
    if (samples.length > WINDOW_SIZE) samples.shift();

    const zhCount = samples.filter((s) => s === "zh").length;
    current = zhCount / samples.length >= ZH_MAJORITY ? "zh" : "en";
  });
}