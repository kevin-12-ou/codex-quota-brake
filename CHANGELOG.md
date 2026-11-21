# Changelog

## v0.1.0 — 2026-11-21

首个可用版本。

- 5 小时 / 周额度任一达到阈值 → 终止正在串流的 `codex.exe app-server`，当前回合立即结束
- 额度读取走本机 app-server `account/rateLimits/read`，不消耗额度
- 判活双通道：桌面版日志行增量（30 秒 ≥2 行）+ CLI 进程 CPU（18 秒 ≥0.3 秒）
- 18 秒二次确认，避免误杀空闲 app-server
- 只杀 `codex.exe`；按 pid 去重；30 秒冷却；10 分钟滑动窗口内最多 20 次
- 配置热更新、单实例锁、日志截断（8MB）、桌面气泡通知
- `install.ps1` / `uninstall.ps1`（含 `.cmd` 双击版），Windows 一键安装
- README 配图与 `docs/DESIGN.md` 设计说明
