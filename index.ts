// run-token-stats —— 合并 @carlosgtrz/pi-run-timer + @liziy/token-stats 的单一插件
// =============================================================================
// Footer 上行：run 计时（● run 01:23 · prev 00:40 · max 03:12）+ token 指标
//              （输入/输出/总量、缓存命中、速率、上下文、套餐配额），右侧模型名
// Footer 下行：cwd + git 分支 + 其他扩展状态
//
// 命令：/stats [day [date] | hour [date] | week | month [YYYY-MM] | limit | config]
//       无参显示当天统计；limit 进入套餐配置；config 进入样式/刷新设置
//
// 模块划分：
//   run-timer.ts   —— run 计时状态机 + session 持久化（原 pi-run-timer）
//   token-stats.ts —— token 统计 + 套餐配额 + JSONL 日志 + /stats（原 token-stats）
//   notify.ts      —— macOS 完成通知（成功/失败/中止）
//   step-timer.ts  —— 任务计时（Working 实时耗时 + 总耗时汇总）
//   thinking-memory.ts —— 按模型自动记忆思考强度（手动切换时记录，默认开启）
//
// 与两个原包的兼容性：
//   - 配置沿用 ~/.pi/agent/extensions/token-stats/{config.json,display-config.json}
//   - 日志沿用 ~/.pi/agent/extensions/token-stats-logs/
//   - 计时状态沿用 session 内 "run-timer-state" 自定义条目

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createTokenStats, formatUserPath, type SharedState } from "./token-stats.ts";
import { createNotifier } from "./notify.ts";
import { createStepTimer } from "./step-timer.ts";
import { createThinkingMemory } from "./thinking-memory.ts";
import { createUserLanguage } from "./user-language.ts";

const shared: SharedState = {
  sessionActive: false,
  requestRender: null,
};

export default function runTokenStatsExtension(pi: ExtensionAPI) {
  const stats = createTokenStats(pi, shared);

  // 语言判断最先初始化：其他模块的文案随用户语言切换（直接读环境变量）
  createUserLanguage();

  // macOS 完成通知（成功/失败/中止），配置见 notify-config.json
  createNotifier(pi);
  // 每步耗时：Thinking.../Working... 实时耗时 + 每 turn/总耗时会话摘要
  createStepTimer(pi, shared);
  // 按模型自动记忆思考强度（/auto-remember-thinking-level），默认开启
  createThinkingMemory(pi);

  pi.on("session_start", (_event, ctx) => {
    shared.sessionActive = true;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const render = () => tui.requestRender();
      shared.requestRender = render;
      const unsub = footerData.onBranchChange(render);

      return {
        dispose() {
          unsub();
          if (shared.requestRender === render) shared.requestRender = null;
        },
        invalidate() {},
        render(width: number): string[] {
          // session 替换后旧 footer 可能仍被 TUI 渲染，此时 ctx 已失效，直接返回空
          if (!shared.sessionActive) return [];

          // ── 上行：指标左对齐，模型名右对齐 ──
          const leftParts: string[] = [];
          leftParts.push(...stats.getMetricParts(theme, ctx));
          const left = leftParts.join(" | ");

          const modelName = ctx.model?.id || "";
          const provider = ctx.model?.provider || "";
          const level = ctx.thinkingLevel || "off";
          const rightSide = (provider ? `(${provider}) ${modelName}` : modelName) + ` · ${level}`;

          const leftWidth = visibleWidth(left);
          const rightWidth = visibleWidth(rightSide);
          const topLine = leftWidth + rightWidth <= width
            ? left + " ".repeat(width - leftWidth - rightWidth) + rightSide
            : leftWidth <= width
              ? left + " ".repeat(width - leftWidth) + truncateToWidth(rightSide, Math.max(0, width - leftWidth), "")
              : truncateToWidth(left, width);

          // ── 下行：cwd + git 分支 + 其他扩展状态 ────
          const cwd = formatUserPath(ctx.cwd || "");
          const branch = footerData.getGitBranch();
          const cwdPart = branch ? `${cwd} (${branch})` : cwd;

          const statuses = footerData.getExtensionStatuses();
          const otherStatuses = Array.from(statuses.entries())
            .filter(([k]) => k !== "token-stats-webui")
            .map(([, v]) => v as string);

          const bottomParts: string[] = [theme.fg("dim", cwdPart)];
          if (otherStatuses.length > 0) {
            bottomParts.push(theme.fg("dim", "│"));
            bottomParts.push(...otherStatuses);
          }

          return [
            truncateToWidth(topLine, width),
            truncateToWidth(bottomParts.join(" "), width),
          ];
        },
      };
    });
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    shared.sessionActive = false;
    shared.requestRender = null;
  });
}
