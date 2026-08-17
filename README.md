# token-stats-timer

`@liziy/token-stats` 的修改版本。

一个扩展、一个 footer，同时提供 run 计时与 token 用量/配额监控。

## 功能

Footer 上行（左对齐）：

```
↑12k ↓3.4k CH87% ⚡77.7 t/s 5.3%/1.0M | 5h: 87% W: 92% ⏱ 2h 15m
```

- `prev` / `max` —— 上一次 run 耗时 / 本会话分支内最长 run 耗时（带 15 字 prompt 预览）
- `↑ ↓ Σ CH` —— 累计输入 / 输出 / 总量 / 缓存命中率
- `⚡` —— 实时速率（2s rolling window，无流时回落到平均速率）
- 上下文占用（样式可配）
- `5h: W: ⏱` —— 套餐剩余（MiniMax / GLM / Kimi / DeepSeek 内置套餐，需在 /stats 里为当前 provider 启用）

Footer 下行：cwd + git 分支 + 其他扩展状态。

## macOS 完成通知

每次 run（agent 任务）结束后弹系统通知，区分两种结果：

- ✅ pi 执行完成 —— 正常结束（含耗时）
- ⏹ pi 已中止 —— 用户 Esc 中止

会话关闭时另有 👋 提示（可关）。

### 投递通道（自动降级，优先用能送达的）

1. **OSC 终端协议** —— 向终端写转义序列，由**终端应用自己**弹系统通知，归属明确，无需 osascript：
   - **iTerm2 → OSC 9**（`ESC]9;内容`，iTerm2 官方文档的通知序列，**实测有效**）
   - Ghostty / WezTerm / Hyper / rxvt-unicode → OSC 777（`ESC]777;notify;标题;内容`）
   > ⚠️ 注意：OSC 777 在 iTerm2 3.5.x 上会静默忽略（3.6.9 才支持），官方 pi 示例（notify.ts）只发 OSC 777，在 iTerm2 上不生效——本插件已按终端选择序列。
2. **terminal-notifier** —— 装了 `brew install terminal-notifier` 后自动使用，系统级最可靠（`-sender` 指定归属、`-group` 去重）。
3. **osascript** —— 保底（无法用终端协议时的最后手段）。

> 为什么不用纯 osascript：macOS Sequoia 起通知按“调用进程”归属，pi 是 node 进程、无法在系统设置里授权，通知会被静默丢弃（脚本 exit 0 但没弹窗）。OSC 序列把归属改到终端 App，授权后即可正常弹。

每次投递结果追加到 `~/.pi/agent/extensions/token-stats-logs/notify.log`，没弹通知时先看它判断是触发问题还是投递问题。

### 配置

配置文件：`~/.pi/agent/extensions/token-stats/notify-config.json`（不存在时用默认值）

```json
{
  "enabled": true,
  "minDurationSec": 0,
  "sound": "Glass",
  "onSuccess": true,
  "onFailure": true,
  "onAbort": true,
  "onSessionEnd": true
}
```

- `enabled` —— 总开关（也可用 `/notify on|off` 切换）
- `minDurationSec` —— 耗时低于该秒数的 run 不通知（设为 30 可避免秒回打扰）
- `sound` —— 通知声音（macOS 内置：Glass/Ping/Sosumi/Hero/Funk 等，`""` 静音；注意仅 osascript/terminal-notifier 通道有声，OSC 777 无声音参数）
- `onSuccess/onFailure/onAbort/onSessionEnd` —— 各类通知开关

`/notify` —— 无参查看当前状态；`on`/`off` 开关；`test` 立即发一条测试通知验证通道是否可达（先看系统通知栏有没有，没有再看 notify.log）。

## 任务计时（step-timer）

- 任务执行中：工作指示器（spinner 文案）显示 `Working... 01:02`（整体已耗时，每秒刷新）
- 完成后：会话末尾插入一条汇总，仅显示总耗时：

  `总耗时 01:23`

  经 `appendEntry` 持久化、不进入 LLM 上下文，`/resume` 后仍在。

无独立开关，随包启用；计时口径与 run-timer 一致（一次 run = 首个 agent_start → agent_settled，含重试/压缩/排队提示）。

## 命令

- `/stats` —— 无参进入套餐配置（为当前 provider 选择/关闭配额套餐）
- `/stats day [YYYY-MM-DD]` / `hour` / `week` / `month [YYYY-MM]` —— 统计查询
- `/stats config` —— 显示样式 / 显示内容 / 配额刷新时间
- `/notify [on|off|test]` —— 通知开关 / 测试（无参查看状态）

## 与两个原包的兼容性

- 显示/套餐配置沿用 `~/.pi/agent/extensions/token-stats/`（原 token-stats 的配置直接生效）
- 统计日志沿用 `~/.pi/agent/extensions/token-stats-logs/`（历史数据 `/stats` 可直接查询）
- run 计时状态沿用 session 内 `run-timer-state` 自定义条目（`/reload` 后自动恢复，兼容旧 `turn-timer-state`）

## 安装（替换原包）

```bash
pi remove npm:@liziy/token-stats
pi install npm:token-stats-timer
```

`/reload` 或重启 pi 生效。
