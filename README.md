# AssistPort

Temporary, user-authorized Windows access for humans and agents.

[![Windows checks](https://github.com/SatoriYoukai/assistport/actions/workflows/windows.yml/badge.svg)](https://github.com/SatoriYoukai/assistport/actions/workflows/windows.yml)

让用户用少量操作，把一台 Windows 电脑临时交给可信的技术协助者或 agent。

第一版面向个人技术协助与 agent 用户，优先支持帮助亲友排障、维护和修复电脑的场景。

**设计原则：一次授权，一次有期限的能力会话。** 目标电脑主动回连接入端；协助者获得 PowerShell 和文件传输能力。项目负责接入、身份验证和会话生命周期，agent 负责理解问题与选择操作。

AssistPort 意为“协助入口”。目前是 Windows 优先的实验原型，采用 MIT 许可证。源码中保留 `CodexTemporarySupport` 运行目录名以兼容原型；人工 CLI 与不同 agent 共用接入接口，不绑定特定模型或平台。

## 已有能力

- 公网 WSS 内承载 SSH，或直接 TCP/SSH；目标侧 SSH 只监听回环地址。
- 独立会话密钥、双向主机密钥验证、目标身份首次登记后固定。
- PowerShell 执行、SFTP 上传下载、真实命令连通性探测。
- 默认四小时、最长二十四小时；控制端撤销与目标端停止。
- Windows 管理员 bootstrap、隔离的 SSH 配置、启动及到期计划任务。
- 默认完整协助的范围声明，bootstrap 后自动显示会话信息/停止窗口原型。
- 内置截图能力原型：按需启用/验证、检查、停止、清理和图片下载；外部工具来源登记。
- 共用 CLI/JavaScript API 的 v1 结果、错误码与操作编号；单会话 MCP stdio 适配。

鼠标键盘控制、可见操作日志窗口和通用诊断流程尚未纳入本项目。已在一台独立 Windows 11 上验证 SYSTEM 回连、管理员 SSH、SFTP 和已登录桌面的单次截图；跨环境兼容、锁屏/UAC、重启恢复及结束清理仍待验收。管理员 SSH 尚无命令级系统隔离。当前为实验性源码版本，未经过独立安全审计。设计与边界见 [DESIGN.md](docs/DESIGN.md)，验证证据见 [VERIFICATION.md](VERIFICATION.md)。

## 快速开始：接入端

接入端需要 Windows、Node.js 22+ 和 Windows PowerShell 5.1，下列克隆命令还需 Git。目标电脑需要 Windows 10/11 x64、管理员授权，以及可通过 Windows Optional Feature 安装的 OpenSSH Server，或下述高级便携 SSH 选项。WSS 公网入口示例使用自行安装的 cloudflared，也可以自行提供支持 WebSocket 的 HTTPS 入口。

下列命令在项目目录的 PowerShell 中运行。若脚本被执行策略阻止，可先在本次 PowerShell 窗口执行 `Set-ExecutionPolicy -Scope Process Bypass`；此设置随该进程退出失效，组织策略仍可能禁止执行。

```powershell
git clone https://github.com/SatoriYoukai/assistport.git
cd assistport
npm ci --ignore-scripts
.\Start-Receiver.ps1 -QuickTunnel -CloudflaredPath 'C:\tools\cloudflared.exe' -StateDirectory 'C:\support-private'
.\New-SupportPackage.ps1 -StateDirectory 'C:\support-private' -OutputDirectory 'C:\support-handoff' -Hours 4 -Scope full -OperatorLabel '技术协助者'
```

只将生成的 `Target-Support-<ID>.zip` 交给获授权的目标用户。**ZIP 含临时回连凭据**，不可放入公共仓库、公开下载目录或 issue。控制端 private-state 含更敏感的控制私钥，永远不要发给目标用户。

打包会解压最终 ZIP，以 Windows PowerShell 5.1 执行包内 Bootstrap -CheckOnly，失败则撤销该会话。该预检查覆盖配置读取和运行时完整性，不代替目标上的组件安装、UAC 或实际连接。

教室等环境可能无法通过 Windows 组件服务安装 OpenSSH。高级用户可传入审核过的 `-OpenSshDirectory 'C:\reviewed\openssh'`，其中包含 binaries、LICENSE/NOTICE 与 manifest.json；生成包固定 manifest hash，目标逐文件校验 hash 和 Microsoft 签名。便携模式不调用 Add-WindowsCapability，仍由本次 SYSTEM 任务运行回环 SSH。仓库尚未提供发行目录准备与下载自动化，不能直接把任意上游 ZIP 当作该目录；校验格式见 [Read-SupportSsh.ps1](target/Read-SupportSsh.ps1)。一台 Windows 11 上的实际 SYSTEM/ACL 接入已验证，跨环境兼容仍待验收。

真正 TCP 公网直连需要接入端可入站的公网地址、路由和防火墙条件：

```powershell
.\Start-Receiver.ps1 -DirectPort 22222 -DirectBind '::' -StateDirectory 'C:\support-private'
.\New-SupportPackage.ps1 -Transport tcp -ReceiverHost 'YOUR_PUBLIC_HOST' -ReceiverPort 22222 -StateDirectory 'C:\support-private' -OutputDirectory 'C:\support-handoff'
```

脚本不会自动修改公网防火墙、DNS 或路由器。默认控制端反向监听端口 23022；并行会话需要分别指定 `-ReversePort`。Quick Tunnel 地址可能随重启变化，旧包不会自动获得新地址。

## 目标电脑

Windows 10/11 x64，解压 ZIP 后运行 `START.cmd`，确认 UAC；或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Bootstrap.ps1
```

授权现有本地 Windows 账户，不创建新用户、不索取密码。仅支持简单本地账户名；标准账户不会因为 bootstrap 提权自动获得管理员权限。目标电脑可能需要下载 Windows OpenSSH 组件，首次启动耗时受组件源影响。包内附 Node 运行时及其许可证。

运行命令与必要的 UAC 后直接接入，没有额外前置确认。Bootstrap 会尝试在当前登录用户桌面显示协助者名称、授权账户、完整协助范围、期限和停止入口；关闭窗口不结束会话。停止按钮调用原 Stop 脚本，可能需要 UAC。显示用 `info.json` 与私密 `session.json` 分离，登录用户只获得显示文件读取权；自动启动、文件权限及按钮行为还需 VM 验收。窗口显示“须由协助者验证真实命令”，不把 bootstrap 完成当成连通成功。

重试请运行 `RETRY.cmd`。Bootstrap 与 Stop 的具体行为见目标包中的 `TARGET-README.txt`。

## 操作与验证

CLI 统一返回 `apiVersion: 1`、`operationId`、`ok`、`result`、`error`；命令输出位于 `result.stdout` / `result.stderr` / `result.exitCode`。失败返回机器可读错误码及 `completion`，CLI 退出 1。旧版本的顶层结果移到了 `result`。完整约定见 [INTERFACES.md](docs/INTERFACES.md)。

`Session` 使用生成结果中的 `ControllerSession` 路径：

```powershell
.\Support.ps1 -Action status -Session 'C:\support-private\sessions\SESSION_ID'
.\Support.ps1 -Action probe -Session 'C:\support-private\sessions\SESSION_ID' -Timeout 10
.\Support.ps1 -Action exec -Session 'C:\support-private\sessions\SESSION_ID' -Command 'whoami; Get-Date'
.\Support.ps1 -Action exec -Session 'C:\support-private\sessions\SESSION_ID' -File 'C:\scripts\diagnose.ps1'
.\Support.ps1 -Action upload -Session 'C:\support-private\sessions\SESSION_ID' -Local 'C:\scripts\diagnose.ps1' -Remote 'C:/Users/USER/diagnose.ps1'
.\Support.ps1 -Action download -Session 'C:\support-private\sessions\SESSION_ID' -Remote 'C:/Users/USER/result.txt' -Local 'C:\results\result.txt'
```

`status` 是本地授权与历史登记信息，`connectivity: unknown`。`probe` 经过密钥校验运行随机挑战命令，只在该命令成功时返回 `connected: true`，证明探测时刻具备执行能力。探测失败时 CLI 退出码为 1；失败不是恶意行为的判据。

命令返回 stdout、stderr、退出码；输出上限 4 MiB，脚本上限 8 MiB。短脚本使用 EncodedCommand，长脚本自动写入远端账户的受限临时目录，以 UTF-8 BOM 保存并校验 SHA-256 后执行。结果中的 `execution.mode` 为 `inline` 或 `staged`；正常结束会删除临时文件及空目录。`--file` 的本地输入按 UTF-8 读取，远端 `$PSScriptRoot` 是 staging 目录，关联资源需另行上传并使用明确路径。

Timeout 包含握手、上传、执行及清理，总范围 1–3600 秒。超时或断线后远端命令可能仍在运行，清理可能未完成；超时错误会附可用的临时脚本路径，先检查现场再决定是否重试。项目不自动重新执行命令。目录只授予当前账户、SYSTEM 和管理员访问权；隔离、正常清理和断线报告不等于能够撤销脚本做过的系统更改。

任何能够运行本地命令的 agent 都能使用 CLI。SSH 后台会话不等于登录用户桌面；后续 GUI 能力需要独立部署及用户授权。

## 通过 MCP 交给 agent

控制端安装依赖后，让 MCP host 启动：

```powershell
node .\mcp-server.js --session 'C:\support-private\sessions\SESSION_ID'
```

提供 status、probe、execute、upload、download、screenshot、tools、revoke 八个工具；工具共享 CLI 的验证与操作实现。进程绑定这一会话，工具参数不接受其他 session 或密钥。配置模板见 [mcp.example.json](docs/mcp.example.json)，工具参数与限制见 [INTERFACES.md](docs/INTERFACES.md)。目标包不携带 MCP 依赖。

同一实例拒绝并发远程操作，不排队、不自动重试；status 和 revoke 可立即调用。客户端取消不保证终止远端进程，关闭 MCP 不会自动撤销会话。CLI 和不同 MCP 实例之间尚无全局操作锁。MCP 结果上限 1 MiB，截图只返回文件元数据与下载路径；需要 host 读取 PNG。鼠标键盘能力尚未实现。

## 按需启用截图

需要本项目新版目标包，当前需要管理员 SSH 账户和目标已登录用户。无需额外目标端确认，处于本次 full 声明内：

```powershell
.\Support.ps1 -Action capability -Capability screenshot -Operation ensure -Session 'C:\support-private\sessions\SESSION_ID'
.\Support.ps1 -Action capability -Capability screenshot -Operation capture -Session 'C:\support-private\sessions\SESSION_ID' -Local 'C:\results\desktop.png'
.\Support.ps1 -Action capability -Capability screenshot -Operation inspect -Session 'C:\support-private\sessions\SESSION_ID'
.\Support.ps1 -Action capability -Capability screenshot -Operation stop -Session 'C:\support-private\sessions\SESSION_ID'
.\Support.ps1 -Action capability -Capability screenshot -Operation cleanup -Session 'C:\support-private\sessions\SESSION_ID'
```

`ensure` 执行一次新截图来验证，已有实例会复用。`inspect` 只报告历史状态；每次 `capture` 使用新请求编号。默认捕获虚拟桌面上的所有显示器；锁屏和 UAC 安全桌面不支持。图片保留在会话 `capability-state/screenshot/captures`，按 SHA-256 校验后下载。`stop` 暂停任务，后续 ensure/capture 可恢复；`cleanup` 注销自有任务并移除未修改的自有脚本，保留图片及诊断记录。已清理实例不静默重建，使用新会话。

短暂断线不立即删除资源；目标 Stop 或到期任务会调用截图清理。控制端 revoke 关闭访问，不等于已清理离线目标。清理若发现配置、哈希或 PID 身份变化，保留资源并报告失败。实际 Windows 任务派生进程回收尚待实机验收。生命周期与来源策略见 [CAPABILITIES.md](docs/CAPABILITIES.md)。

## 登记外部工具来源

内置能力优先，允许在本次范围内增加经审核的工具。参考 [manifest 示例](docs/tool-manifest.example.json)，替换所有占位内容后登记：

```powershell
.\Support.ps1 -Action tool -Operation register -Session 'C:\support-private\sessions\SESSION_ID' -File 'C:\reviewed-tool.json'
.\Support.ps1 -Action tool -Operation inspect -Session 'C:\support-private\sessions\SESSION_ID'
```

登记记录固定版本、来源、预期 hash、审核依据和清理步骤，返回 `installed: false`。当前不自动下载或部署外部工具，也不因填写审核信息而声称已经验证了发布者或下载文件。

## 结束协助

接入端撤销，receiver 每秒检查并关闭会话转发：

```powershell
.\Support.ps1 -Action revoke -Session 'C:\support-private\sessions\SESSION_ID'
.\Stop-Receiver.ps1 -StateDirectory 'C:\support-private'
```

目标用户在解压目录以管理员权限运行 `Stop-Support.ps1`，停止会话、移除任务及运行密钥。控制端 revoke 不等于目标端卸载，目标端可能重试到到期。收到的 ZIP 和解压目录需另外删除。

安装的 OpenSSH Optional Feature 会保留；原有 SSH 服务、账户密钥和配置不应被覆盖。已通过接入安装的软件、已运行命令的系统更改不会随会话结束自动回滚。runner 失败时停止它启动的子进程并保留日志/密钥，由显式 Stop 或独立到期任务清理；不异步启动可能误删修复后密钥的旧清理进程。控制端 staging 文件不在目标运行目录里，断线遗留的 staging 需另外检查。

## 开发与贡献

```powershell
npm ci
npm test
```

测试使用隔离的本地 SSH 测试服务，运行真实 Windows PowerShell，不安装系统服务，不接入实际受助者电脑。具体证据及未覆盖范围见 [VERIFICATION.md](VERIFICATION.md)。贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界见 [SECURITY.md](SECURITY.md)。
