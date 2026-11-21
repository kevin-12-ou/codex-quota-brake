# Codex Quota Brake

**额度一到阈值，就把正在生成的回合停掉。** 5 小时窗口或周窗口，任一超过阈值即触发。

> 一个 Windows 小工具：轮询 Codex 的额度（不消耗额度），到阈值时终止正在生成的那个
> `codex.exe app-server`，让当前回合立刻结束，不再继续烧配额；窗口重置前再发起的回合也会被停掉。

[English summary ↓](#english)

---

## 它解决什么问题

Codex 的额度是**账号级**的，5 小时一个窗口、每周一个窗口。长任务常见死法不是"写错代码"，
而是**一个跑飞的回合把窗口吃光**，接下来几小时什么都不能干。

官方目前没有"到阈值自动暂停"的开关（社区一直在提）。这个工具补的正是这一段：
**在你还能控制的时候停手**，而不是撞到 100% 才被迫停。

## 它到底怎么"停"

桌面版 App 的 app-server 是 Electron 进程的 stdio 子进程，没有对外的控制 socket，
所以外部没办法"按一下暂停"。实测能真正止住消耗的只有一条路：

```
额度 ≥ 阈值  →  找到正在写日志的那个 app-server 进程  →  taskkill  →  SSE 流断  →  回合结束
```

- **不会丢会话**：线程持久化在 `~/.codex/state_5.sqlite`，之后 `codex resume` 或 `codex queue` 接着跑。
- **不是杀 App**：只杀干活的 app-server 进程；App 会自己把服务拉起来，界面和会话都还在。
- **额度读取不消耗额度**：走 app-server 的 `account/rateLimits/read`，不是模型请求。

## 要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（用到 `taskkill`、`HKCU` 自启、PowerShell） |
| Node.js | **≥ 22.5**（用到内置 `node:sqlite`） |
| Codex | 装了桌面版或 CLI，并且**已用 ChatGPT 账号登录**（`~/.codex/auth.json`） |

不需要任何 API key，不需要额外授权，不联网上传任何东西。

> 实测环境：Windows 11 + Codex 桌面版（app-server 0.171）+ Node 24。Node 22.5 是最低要求。

## 安装

**方式一：直接下 ZIP（不用 git）**

1. 打开 https://github.com/kevin-12-ou/codex-quota-brake
2. 右上角 `Code` → `Download ZIP`，解压到任意目录
3. 双击 `install.cmd`（或在 PowerShell 里跑 `.\install.ps1`）

**方式二：git**

```powershell
git clone https://github.com/kevin-12-ou/codex-quota-brake.git
cd codex-quota-brake
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：检查 Node 版本 → 检查 Codex 是否登录 → 复制到 `%LOCALAPPDATA%\CodexQuotaBrake`
→ 生成 `config.json` → 注册开机自启 → 启动 → 读一次额度自检。

先演练不落地：`.\install.ps1 -DryRun`；
不想开机自启：`.\install.ps1 -NoAutostart`。

> 没登录过 Codex 的话，先打开桌面版登录，或在终端跑 `codex login`。

## 第一次验证（不用等额度真的超）

```powershell
$b = "$env:LOCALAPPDATA\CodexQuotaBrake\quota_brake.mjs"

# 1) 只看判定，不动手（安全）
node $b --once --json

# 2) 造一个"假回合"验证它真的会停（零额度：不联网、不调模型）
Copy-Item "C:\Program Files\nodejs\node.exe" .\faketurn-codex.exe
# 把它当成 codex.exe 用：命令行带 exec + 持续烧一点 CPU
Start-Process .\faketurn-codex.exe -ArgumentList '"burn.js"','exec' -WindowStyle Hidden
```

`burn.js` 只要持续做点计算即可（`setInterval` 里跑个循环）。刹车会在 10~40 秒内把它当成
"正在生成的回合"并终止——日志里出现 `HARD STOP pid ... -> killed` 就说明链路通了。

## 配置

`%LOCALAPPDATA%\CodexQuotaBrake\config.json`，**改完保存即生效，不用重启**：

| 键 | 默认 | 说明 |
|---|---|---|
| `threshold5h` | 85 | 5 小时窗口已用百分比阈值 |
| `thresholdWeekly` | 92 | 周窗口阈值（任一超即触发） |
| `brakeEnabled` | true | 总开关；`false` = 只读额度、不杀任何进程 |
| `brakeMaxKills` | 20 | 10 分钟窗口内最多停几次（防病态循环） |
| `brakeKillWindowSec` | 600 | 上面的窗口长度 |
| `brakeKillCooldownSec` | 30 | 两次动手的最小间隔 |
| `pollSeconds` | 60 | 正常轮询间隔；接近/超过阈值时自动加速到 10~15 秒 |
| `codexBin` | null | 留空自动探测；探测不到时手动指定 `codex.exe` 路径 |

阈值怎么选：留一点余量。一个回合可能吃掉几个百分点，`85/92` 意味着"还能干点别的"；
`98/99` 基本等于"撞墙才停"。

## 日常使用

```powershell
$b = "$env:LOCALAPPDATA\CodexQuotaBrake\quota_brake.mjs"
node $b --once --json            # 看当前额度与判定（不动作）
node $b --once --yes --json      # 真的执行一轮（超阈值就杀）
Get-Content "$env:LOCALAPPDATA\CodexQuotaBrake\.state\brake.log" -Tail 20
```

临时不想让它动手：把 `config.json` 里 `brakeEnabled` 改成 `false` 保存即可，秒生效。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1          # 保留配置和日志
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge   # 全删
```

## 已知限制（请读完再用）

- **只覆盖本机的 `codex.exe`**。额度是账号级的：手机、网页版、另一台机器、别的客户端照扣，
  这个工具管不到。
- **杀进程会让那个 app-server 上所有会话的当前回合一起结束**（不只是触发的那一个）。
  正在写的文件可能留半成品。
- **长时间静默的回合可能漏判**：判活依赖桌面版日志里的行，如果一个回合连续 20 秒以上不写日志
  （纯长推理且无事件），会被判成空闲。这是有意的保守选择——宁可漏停，也不误杀空闲进程。
- **手动点发送的路径没有单独实测**（用的杀进程链路和 CLI/队列触发的是同一条），
  但"阈值到了就停"这件事在 CLI 与队列触发的真实回合上都验证过。
- Windows 专用。macOS/Linux 需要自己替换 `taskkill`、自启方式和进程探测逻辑。
- 阈值判定用后端返回的 `usedPercent`；重置倒计时只用于展示，不参与"是否恢复"的判断。

## 隐私

- 不上传任何数据，没有遥测。
- 日志只写本地：`.state\brake.log`，内容是额度百分比、pid、线程 id 前 8 位。
- 不读取、也不保存你的凭据；额度查询走本机已登录的 Codex app-server。

## 开发

- 设计说明与实测记录（判活规则、为什么杀进程、踩过的坑）：[docs/DESIGN.md](docs/DESIGN.md)
- 单文件实现：`src/quota_brake.mjs`（零第三方依赖）
- 自测注入点：`--fake-percent` / `--fake-weekly` / `--fake-active <pid>` / `--dry-run` / `--once`

## English

**Codex Quota Brake** stops the currently generating Codex turn as soon as either the 5-hour or the
weekly quota window crosses a configurable threshold — so a runaway task can't burn the whole window.

- Windows only, Node ≥ 22.5, requires an already logged-in Codex install (no API keys).
- Reads quota through the local app-server (`account/rateLimits/read`), which does not consume quota.
- To stop a turn it terminates the `codex.exe` app-server that is streaming the turn; the thread is
  persisted and can be resumed with `codex resume`.
- Install: `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`
- Config: `%LOCALAPPDATA%\CodexQuotaBrake\config.json` (hot-reloaded).

## License

MIT — see [LICENSE](LICENSE).
