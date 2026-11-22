# Changelog

## v0.1.1 — 2026-11-22

- **软预警 `warnAt`（默认 80%）**：到线先弹一次通知，同一窗口周期只提醒一次（按 `resetsAt` 去重），
  让人有机会自己收尾，而不是等到阈值被动硬停
- 修：没有 `config.json` 时每拍都写一条 `config reload skipped` 噪音日志（现在静默用默认值）
- 文档：FAQ 增加"撞满额度会不会降权/降智"的实测口径（本机日志 `model_rerouted` 0 次、指纹检测 10/10 正常）

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
