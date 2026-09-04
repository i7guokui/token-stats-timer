# token-stats-timer

> [English](README.en.md) | 简体中文（当前）

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
- `5h: W: ⏱` —— 套餐剩余（MiniMax / GLM / Kimi / DeepSeek / OpenCode Go / Command Code 内置套餐，需在 /stats 里为当前 provider 启用）

Footer 下行：cwd + git 分支 + 其他扩展状态。

## 按模型自动记忆思考强度（thinking-memory）

不用命令手动设置，**手动切换思考强度时自动记录**为当前模型的默认级别，
会话启动 / 切换模型时自动恢复。参考 `@tifan/pi-preferred-thinking` 的按模型偏好机制，
改为以实际切换行为作为记忆来源（默认开启）：

- 手动切换 thinking level（快捷键 / /thinking / 设置界面）→ 自动记录到当前模型
- `session_start` / `model_select` → 自动应用该模型记忆的级别
- 自身 `setThinkingLevel` 与模型切换引发的级别变化（如不支持 max 被 clamp）不会误记录

- `/auto-remember-thinking-level` —— 无参查看状态；`on` / `off` 启用或禁用（默认开启）

配置：`~/.pi/agent/extensions/token-stats/auto-remember-thinking-level.json`

```json
{
  "enabled": true,
  "levels": {
    "opencode-go/deepseek-v4-flash": "max"
  }
}
```

> 若同时安装原 `@tifan/pi-preferred-thinking`，其 session_start 自动应用会与本功能互相覆盖，建议二选一。

## 按工作目录记忆上次切换的模型（model-memory）

在新目录开启新会话时自动用该目录**最后一次手动切换的模型**，替代 pi 的全局默认模型（默认开启）：

- 手动切换模型（`/model` 选择 / Ctrl+P 循环）→ 以当前 `cwd` 为 key 记录该模型
- 新开会话（启动时空白会话 / `/new`）：若初始模型正是 pi 的全局默认模型，则自动切换到该目录记忆的模型
- 若该目录没有记忆、记忆模型已失效/无鉴权，或初始模型是 `--model` / `--models` 显式指定（不是默认模型），则不干预，保持 pi 原行为
- 恢复会话（`--continue` / `--resume` / 切换会话）不受影响：仍恢复会话自身最后使用的模型

- `/auto-remember-model` —— 无参查看状态；`on` / `off` 启用或禁用（默认开启）；`forget` 清除当前目录记忆

配置：`~/.pi/agent/extensions/token-stats/model-memory.json`

```json
{
  "enabled": true,
  "cwdModels": {
    "/path/to/project": { "provider": "cmd", "modelId": "deepseek/deepseek-v4-pro", "at": 1725000000000 }
  }
}
```

> 与 thinking-memory 互补：切到记忆模型后，会照常应用该模型记忆的思考强度。

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

`/notify` —— 无参查看当前状态；`on`/`off` 开关；`test` 立即发一条测试通知验证通道是否可达。

## 任务计时（step-timer）

- 任务执行中：工作指示器（spinner 文案）显示 `Working... 01:02`（整体已耗时，每秒刷新）
- 完成后：会话末尾插入一条汇总，完成时刻（24 小时制系统时间）独占第一行，第二行为总耗时与本次任务的 token 指标（输入/输出/总量/缓存命中率/平均速率，对齐 footer 风格）：

  ```
  [2026-08-26 10:20:12]
  总耗时：01:23  ↑1.2k ↓345 Σ1.5k CH80% ⚡12.3 t/s
  ```

  经 `appendEntry` 持久化、不进入 LLM 上下文，`/resume` 后仍在。

无独立开关，随包启用；计时口径与 run-timer 一致（一次 run = 首个 agent_start → agent_settled，含重试/压缩/排队提示）。

## 命令

- `/stats` —— 无参默认显示**当天 token 统计**（等价 `/stats day`）
- `/stats day [YYYY-MM-DD]` / `hour` / `week` / `month [YYYY-MM]` —— 统计查询
- `/stats limit` —— 套餐配置（为当前 provider 选择/关闭配额套餐；选 GLM 后会继续询问是否配置团队套餐凭证）
- `/stats config` —— 显示样式 / 显示内容 / 配额刷新时间 / GLM 团队凭证
- `/notify [on|off|test]` —— 通知开关 / 测试（无参查看状态）
- `/auto-remember-thinking-level [on|off]` —— 自动记忆思考强度开关（无参查看状态）
- `/auto-remember-model [on|off|forget]` —— 按目录记忆上次切换的模型开关 / 清除当前目录记忆（无参查看状态）

## GLM 团队套餐（Team Plan）

个人版与团队版共用 `GET /api/monitor/usage/quota/limit`，区别在请求头：团队版需额外携带 `Bigmodel-Organization` / `Bigmodel-Project` 两个请求头并加 `?type=2`（api_key + 组织 ID + 项目 ID 三者缺一不可，仅国内站 `open.bigmodel.cn` 有团队档）。

本插件在**组织 ID 与项目 ID 都配置**时才走团队查询，否则回退个人版查询：

- 启用 GLM 套餐后（`/stats limit` 选 GLM）会自动弹出团队凭证配置询问，可「✏️ 配置/修改」或「跳过」
- 随时可通过 `/stats config` → 「GLM 团队凭证」修改或清除
- 凭证保存在 `~/.pi/agent/extensions/token-stats/config.json` 的 `teamCredential` 字段：

```json
{
  "providerPlans": { "zai-coding-cn": "glm" },
  "teamCredential": { "organization": "your-org-id", "project": "your-project-id" },
  "ttl": 60
}
```

> 组织 ID / 项目 ID 在 GLM Coding Plan 团队版后台「团队编程套餐」页面获取；如果你同时使用 Claude Code / Cursor 等工具并已在环境变量里配置，也可以在 config.json 里直接填上同名值。

## OpenCode Go 余额

OpenCode Go 订阅（`opencode-go` provider，baseUrl `https://opencode.ai/zen/go/v1`）使用官方配额接口 `GET /zen/go/v1/usage`（`Authorization: Bearer <key>`，即 auth.json 里 `opencode-go` 的 `key` 或环境变量 `OPENCODE_API_KEY`），返回三个滚动窗口的已用百分比：5 小时 / 周 / 月。

footer 显示 `5h: X% W: Y% M: Z% ⏱ ...`（剩余比例 = 100 - 已用），后三个子项可分别用 `/stats config` → 显示内容 的「5h额度 / 周额度 / 月额度 / 刷新时间」开关控制。

## 与原包的兼容性

- 显示/套餐配置沿用 `~/.pi/agent/extensions/token-stats/`（原 token-stats 的配置直接生效）
- 统计日志沿用 `~/.pi/agent/extensions/token-stats-logs/`（历史数据 `/stats` 可直接查询）

## 安装（替换原包）

```bash
pi remove npm:@liziy/token-stats
pi install npm:token-stats-timer
```

`/reload` 或重启 pi 生效。
