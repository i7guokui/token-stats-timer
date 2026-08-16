# token-stats-timer

`@carlosgtrz/pi-run-timer` 与 `@liziy/token-stats` 的合并插件。

一个扩展、一个 footer，同时提供 run 计时与 token 用量/配额监控。

## 功能

Footer 上行（左对齐）：

```
● run 01:23 · prev 00:40 · max 03:12 (Review README…) | ↑12k ↓3.4k CH87% ⚡77.7 t/s 5.3%/1.0M | 5h: 87% W: 92% ⏱ 2h 15m
```

- `● run 01:23` —— 当前 run 已耗时（从空闲后的第一个 `agent_start` 到 `agent_settled`，含重试/压缩恢复/排队提示）
- `prev` / `max` —— 上一次 run 耗时 / 本会话分支内最长 run 耗时（带 15 字 prompt 预览）
- `↑ ↓ Σ CH` —— 累计输入 / 输出 / 总量 / 缓存命中率
- `⚡` —— 实时速率（2s rolling window，无流时回落到平均速率）
- 上下文占用（样式可配）
- `5h: W: ⏱` —— 套餐剩余（MiniMax / GLM / Kimi / DeepSeek 内置套餐，需在 /stats 里为当前 provider 启用）

Footer 下行：cwd + git 分支 + 其他扩展状态。

## 命令

- `/stats` —— 无参进入套餐配置（为当前 provider 选择/关闭配额套餐）
- `/stats day [YYYY-MM-DD]` / `hour` / `week` / `month [YYYY-MM]` —— 统计查询
- `/stats config` —— 显示样式 / 显示内容（含「计时器」开关）/ 配额刷新时间

## 与两个原包的兼容性

- 显示/套餐配置沿用 `~/.pi/agent/extensions/token-stats/`（原 token-stats 的配置直接生效）
- 统计日志沿用 `~/.pi/agent/extensions/token-stats-logs/`（历史数据 `/stats` 可直接查询）
- run 计时状态沿用 session 内 `run-timer-state` 自定义条目（`/reload` 后自动恢复，兼容旧 `turn-timer-state`）

## 安装（替换两个原包）

```bash
pi remove npm:@carlosgtrz/pi-run-timer
pi remove npm:@liziy/token-stats
```

本目录已在 `~/.pi/agent/extensions/` 下，自动发现，`/reload` 或重启 pi 生效。
