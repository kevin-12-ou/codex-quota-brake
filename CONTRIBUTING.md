# 参与贡献

## 本地跑起来

```powershell
# 只看判定（默认不动作，安全）
node src\quota_brake.mjs --once --json

# 装到临时目录演练（不写注册表、不启动）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun -Prefix "$env:TEMP\brake-dry"
```

## 测"到阈值会真的停"（零额度）

不要拿真实模型请求去测。做法是造一个**假回合**：它的名字、命令行、CPU 行为都和真回合一样，
但完全不联网。

```powershell
New-Item -ItemType Directory -Force .\faketurn | Out-Null
Copy-Item "C:\Program Files\nodejs\node.exe" .\faketurn\codex.exe
@'
const end = Date.now() + 120000;
(function tick(){ if (Date.now() > end) return; let x=0; for (let i=0;i<2e6;i++) x+=i; setTimeout(tick,20); })();
'@ | Set-Content .\faketurn\burn.js
Start-Process .\faketurn\codex.exe -ArgumentList '"burn.js"','exec' -WindowStyle Hidden
# 然后在 config.json 里把阈值临时调到当前额度以下，或直接：
node src\quota_brake.mjs --once --yes --json
```

看到 `HARD STOP pid ... -> killed` 就说明链路通了。

## 约定

- **零第三方依赖**：只用 Node 内置模块 + Windows 自带命令。
- **PowerShell 5.1 兼容**：`.ps1` 文件必须 **UTF-8 带 BOM**，否则 5.1 会按 ANSI 读，中文变乱码、语法报错。
- **不要把阈值语义写死**：判定逻辑尽量保持纯函数（`killDecision` / `pickGenerating`），方便加用例。
- **提交前**：`node --check src/quota_brake.mjs`，并确认 CI 的 smoke 用例全绿。

## 不要提交

- `config.json`（本地配置）、`.state/`（日志与状态）、`faketurn/`（测试替身）；
- 任何凭据、token、真实的线程 id 或会话标题。
