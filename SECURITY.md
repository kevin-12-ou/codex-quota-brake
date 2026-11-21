# Security

## 报告问题

发现安全问题时，请用 GitHub 的 **Private vulnerability reporting**（仓库页 → Security → Report a vulnerability），
不要开公开 issue。

## 这个项目会做什么（判断风险时请以此为准）

- 读取 `~/.codex/logs_<n>.sqlite` 里的**只读**元数据（线程 id、时间戳、进程 pid）；
- 通过本机 app-server 查询额度（`account/rateLimits/read`）；
- **终止镜像名严格等于 `codex.exe` 的进程**（`taskkill /F`），并以 pid 白名单方式校验；
- 往 `%LOCALAPPDATA%\CodexQuotaBrake\.state\` 写日志与状态；
- 注册一个 `HKCU\...\Run` 自启项（安装时，`-NoAutostart` 可跳过）。

## 它不会做什么

- 不读取、不传输、不保存你的凭据或 token；
- 不联网上传任何数据（只在查询额度时由 Codex 自身访问其后端）；
- 不修改 Codex 的安装目录或配置文件；
- 不需要管理员权限。

## 攻击面

| 面 | 说明 |
|---|---|
| 进程终止 | 只对 `codex.exe` 生效；攻击者若能改本机进程名，本机已沦陷，不在威胁模型内 |
| 配置 | `config.json` 在同用户目录下；能被改写者已具备同等权限 |
| 自启项 | 仅 `HKCU`，不触碰系统级位置 |
| 日志 | 本地文件，含 pid 与线程 id 前 8 位，不含 prompt 内容 |

## 支持范围

只在 Windows 10/11 + Node ≥ 22.5 上测试。旧版本 Node 或非 Windows 平台的问题不在支持范围内。
