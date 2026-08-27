# token-stats-timer

> [简体中文](README.md) | English (current)

A modified version of `@liziy/token-stats`.

One extension, one footer — run timing plus token usage/quota monitoring in a single plugin.

## Features

Footer, top line (left-aligned):

```
↑12k ↓3.4k CH87% ⚡77.7 t/s 5.3%/1.0M | 5h: 87% W: 92% ⏱ 2h 15m
```

- `prev` / `max` —— duration of the previous run / longest run in this session branch (with a 15-char prompt preview)
- `↑ ↓ Σ CH` —— cumulative input / output / total / cache hit rate
- `⚡` —— live speed (2s rolling window; falls back to the average speed while idle)
- Context usage (style configurable)
- `5h: W: ⏱` —— quota remaining (built-in plans for MiniMax / GLM / Kimi / DeepSeek / OpenCode Go / Command Code; enable per provider in `/stats`)

Footer, bottom line: cwd + git branch + statuses from other extensions.

## Per-model thinking level memory (thinking-memory)

No manual setup command: when you **manually switch the thinking level, it is recorded automatically** as the default for the current model, and restored on `session_start` / model switch. Inspired by the per-model preference mechanism of `@tifan/pi-preferred-thinking`, but with your actual switching behavior as the memory source (enabled by default):

- Manually change the thinking level (keybinding / `/thinking` / settings UI) → recorded for the current model
- `session_start` / `model_select` → the remembered level for that model is applied automatically
- Level changes caused by the extension's own `setThinkingLevel` or by model-switch clamping (e.g. a model that doesn't support `max`) are never misrecorded

- `/auto-remember-thinking-level` — no arg shows status; `on` / `off` enable or disable (enabled by default)

Config: `~/.pi/agent/extensions/token-stats/auto-remember-thinking-level.json`

```json
{
  "enabled": true,
  "levels": {
    "opencode-go/deepseek-v4-flash": "max"
  }
}
```

> If the original `@tifan/pi-preferred-thinking` is also installed, its session_start auto-apply overrides this feature and vice versa — install only one of them.

## macOS completion notifications

A system notification is posted when each run (agent task) finishes, distinguishing two outcomes:

- ✅ pi task finished — normal completion (with duration)
- ⏹ pi aborted — aborted via Esc

A separate 👋 notification on session close (optional).

### Delivery channels (automatic fallback, best available wins)

1. **OSC terminal protocol** — writes an escape sequence to the terminal; the **terminal app itself** shows the notification, so the sender is the terminal (no osascript needed):
   - **iTerm2 → OSC 9** (`ESC]9;content`, the notification sequence from iTerm2's official docs, **verified working**)
   - Ghostty / WezTerm / Hyper / rxvt-unicode → OSC 777 (`ESC]777;notify;title;content`)
   > ⚠️ Note: OSC 777 is silently ignored on iTerm2 3.5.x (supported since 3.6.9). The official pi example (notify.ts) only sends OSC 777, which does nothing on iTerm2 — this plugin selects the sequence per terminal.
2. **terminal-notifier** — used automatically once `brew install terminal-notifier` is done; most reliable at the system level (`-sender` sets ownership, `-group` dedupes).
3. **osascript** — last-resort fallback (when no terminal protocol is available).

> Why not pure osascript: since macOS Sequoia, notifications are attributed to the *calling process*. pi is a node process that cannot be authorized in System Settings, so the notification is silently dropped (the script exits 0 but no banner appears). OSC sequences re-attribute the notification to the terminal app, which can be authorized and shows banners normally.

### Configuration

Config file: `~/.pi/agent/extensions/token-stats/notify-config.json` (defaults apply if missing)

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

- `enabled` — master switch (also togglable via `/notify on|off`)
- `minDurationSec` — skip notifications for runs shorter than this many seconds (e.g. 30 avoids noise from instant replies)
- `sound` — notification sound (built-in macOS sounds: Glass/Ping/Sosumi/Hero/Funk…; `""` for silent; note only the osascript/terminal-notifier channels support sound — OSC 777 has no sound parameter)
- `onSuccess/onFailure/onAbort/onSessionEnd` — per-category switches

`/notify` — no arg shows current status; `on`/`off` toggle; `test` immediately sends a test notification to verify the channel.

## Run timing (step-timer)

- While working: the spinner text shows `Working... 01:02` (elapsed time, refreshed every second)
- On completion: an entry is appended at the end of the session — the completion time (24h system time) on its own first line, followed by the total duration and this run's token metrics (input/output/total, cache hit rate, avg speed — footer style):

  ```
  [2026-08-26 10:20:12]
  Total time: 01:23  ↑1.2k ↓345 Σ1.5k CH80% ⚡12.3 t/s
  ```

  Persisted via `appendEntry`, kept out of the LLM context, and still visible after `/resume`.

No separate switch — always on with the package; timing semantics match the run timer (one run = first `agent_start` → `agent_settled`, including retries, compaction recovery and queued prompts).

## Commands

- `/stats` — no arg shows **today's token stats** (same as `/stats day`)
- `/stats day [YYYY-MM-DD]` / `hour` / `week` / `month [YYYY-MM]` — stats queries
- `/stats limit` — quota plan config (pick/disable the plan shown for the current provider; picking GLM asks whether to configure team credentials)
- `/stats config` — display style / display items / quota refresh interval / GLM team credentials
- `/notify [on|off|test]` — notifications toggle / test (no arg shows status)
- `/auto-remember-thinking-level [on|off]` — thinking-level memory toggle (no arg shows status)

## GLM Team Plan

Personal and team plans share `GET /api/monitor/usage/quota/limit`; the only difference is the request headers — the team plan requires the `Bigmodel-Organization` / `Bigmodel-Project` headers plus `?type=2` (api_key + organization ID + project ID, all three required; the team tier only exists on the China endpoint `open.bigmodel.cn`).

This plugin uses the team query **only when both the organization ID and the project ID are configured**, otherwise it falls back to the personal query:

- After enabling the GLM plan (`/stats limit` → GLM), a team-credential prompt appears automatically — "✏️ Configure / Edit" or "Skip"
- Change or clear it any time via `/stats config` → "GLM team credentials"
- Credentials are stored in the `teamCredential` field of `~/.pi/agent/extensions/token-stats/config.json`:

```json
{
  "providerPlans": { "zai-coding-cn": "glm" },
  "teamCredential": { "organization": "your-org-id", "project": "your-project-id" },
  "ttl": 60
}
```

> Organization ID / Project ID can be found on the "Team Coding Plan" page of the GLM Coding Plan team console; if you already configure them as environment variables for Claude Code / Cursor or similar tools, you can also put the same values into config.json directly.

## OpenCode Go balance

The OpenCode Go subscription (`opencode-go` provider, baseUrl `https://opencode.ai/zen/go/v1`) uses the official quota endpoint `GET /zen/go/v1/usage` (`Authorization: Bearer <key>` — the `key` of `opencode-go` in auth.json or the `OPENCODE_API_KEY` env var), returning the used percentage of three rolling windows: 5 hours / week / month.

The footer shows `5h: X% W: Y% M: Z% ⏱ ...` (remaining = 100 − used); each of the last three items can be toggled via `/stats config` → Display items → "5h quota / Week quota / Month quota / Refresh time".

## Compatibility with the original packages

- Display/quota config reuses `~/.pi/agent/extensions/token-stats/` (existing token-stats config takes effect as-is)
- Stats logs reuse `~/.pi/agent/extensions/token-stats-logs/` (historical data queryable via `/stats`)

## Installation (replaces the original packages)

```bash
pi remove npm:@liziy/token-stats
pi install npm:token-stats-timer
```

Run `/reload` or restart pi to activate.
