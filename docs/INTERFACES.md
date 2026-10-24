# Agent 接口 v1

CLI、JavaScript API 与 MCP 复用 `operator.operate`，身份验证、声明范围、到期和撤销检查只有一套实现。接入端提供 MCP；目标端只运行回连程序，不安装 MCP 或绑定某一款 agent。

## 统一结果

CLI 与 `lib/operation.invoke` 返回同一 JSON envelope，MCP 返回于 `structuredContent`，同时附等价文本供兼容客户端读取。失败 CLI 退出 1，MCP `isError: true`。

```json
{
  "apiVersion": 1,
  "operationId": "a-generated-uuid",
  "sessionId": "0123456789abcdef",
  "action": "exec",
  "startedAt": "2026-10-12T00:00:00.000Z",
  "finishedAt": "2026-10-12T00:00:00.100Z",
  "durationMs": 100,
  "ok": false,
  "result": { "exitCode": 7, "signal": null, "stdout": "before failure\n", "stderr": "reason\n" },
  "error": { "code": "REMOTE_EXIT", "message": "Remote command exited with code 7.", "completion": "completed" }
}
```

`operationId` 关联本次请求，不是远端持久任务 ID，也不是去重键。当前没有持久操作查询、幂等去重或断线后结果恢复。发出同一命令两次会运行两次。

`ok` 表示这次接口操作成功。status 的 `ok: true` 只证明本地状态读取成功；`registered: true` 是历史登记，不能证明在线。probe 的 `connected: true` 证明一次真实认证挑战完成。截图 `inspect` 返回历史状态，ensure/capture 才验证新图片。revoke 成功证明本地撤销记录已写入，不能证明目标已经清理。

远端退出非零时保留 stdout、stderr、退出码。没有收到退出状态时标为 `REMOTE_OUTCOME_UNKNOWN`。输出过量或传输中断时尽量保留已收到的命令输出；不能证明远端进程已经停止。

CLI 旧的顶层结果改放到 `result`，自动化调用方需改用 `result.stdout` 等路径。JavaScript 的底层 `operate(options)` 保留旧结果/抛异常行为供内部复用；对外建议：

```javascript
const { invoke } = require('./lib/operation');
const response = await invoke({ session: controllerSession, action: 'exec', command: 'whoami', timeout: 30 });
if (!response.ok) console.error(response.error.code, response.error.completion);
```

## 错误与执行状态

| code | 含义 |
|---|---|
| INVALID_ARGUMENT | 动作、参数、脚本或路径不合法，尚未连接目标 |
| SESSION_UNAVAILABLE | 控制端会话不存在或配置无效 |
| SESSION_EXPIRED / SESSION_REVOKED | 会话已经到期或撤销 |
| OUT_OF_SCOPE | 请求不在生成包时声明的范围内 |
| NOT_REGISTERED | 目标尚未登记身份 |
| IDENTITY_MISMATCH | 登记内容或固定主机密钥不匹配 |
| CONNECTION_FAILED | SSH 连接或认证失败 |
| PROBE_FAILED | 探测失败，原因与底层错误见 result |
| OPERATION_BUSY | 这个 MCP 实例已有远程操作；新请求未排队、未发出 |
| OPERATION_TIMEOUT / OPERATION_CANCELLED | 达到总 deadline 或客户端取消；不能自动重试 |
| TRANSPORT_ERROR / TRANSFER_FAILED | 命令通道或文件传输失败 |
| REMOTE_EXIT / REMOTE_OUTCOME_UNKNOWN | 远端退出非零，或未收到退出状态 |
| CAPABILITY_FAILED / INVALID_REMOTE_RESULT | 能力管理失败或验证信息不合法 |
| INTEGRITY_MISMATCH | 下载图片与目标提供的 SHA-256 不符 |
| CLEANUP_INCOMPLETE | 清理保留了内容或归属变化的资源；result 保留记录 |
| OUTPUT_LIMIT / RESULT_LIMIT | 命令输出超过上限，或 MCP 结果超过上限 |
| LOCAL_IO_ERROR / TOOL_REGISTRY_ERROR / OPERATION_FAILED | 本地文件、来源登记或其他操作失败 |

错误的 `completion` 为：

- `not_started`：没有发出远端操作；例如参数校验或 SSH 握手阶段失败。
- `completed`：相应请求已完成，但结果失败；例如已收到退出码 7、或图片下载后哈希不符。
- `unknown`：已经尝试发出远端操作，不能确认其结果。超时、取消和断线可能属于此类；能力脚本退出也不一定证明它启动的桌面子任务已结束。

超时覆盖握手、文件上传、命令和清理。取消关闭本次连接，不承诺终止目标进程。错误可能附 `stagingPath` 与 `cleanup: unconfirmed`；先检查目标进程、能力状态或文件，再主动决定下一步。没有自动重试或自动撤销已运行的操作。探测本身可以完成并报告失败，其底层命令是否完成见 `result.failure.completion`。

## MCP stdio

在安装依赖的控制端启动：

```powershell
node .\mcp-server.js --session 'C:\support-private\sessions\SESSION_ID'
```

一般由 MCP host 启动此进程。配置模板见 [mcp.example.json](mcp.example.json)，替换 Node 路径、源码路径和本次 ControllerSession。不同 host 配置入口可能不同。启动时加载指定会话，工具参数不包含 session、私钥或 token，不能切换另一台目标。关闭 MCP 进程不会结束会话；使用 revoke 或目标 Stop/到期清理。

| 工具 | 参数 | 行为 |
|---|---|---|
| support_status | 无 | 读取本地状态与历史登记 |
| support_probe | timeout 可选，默认 10 秒 | 真实认证挑战 |
| support_execute | command 或 file，timeout 可选 | PowerShell；file 是控制端 UTF-8 文件 |
| support_upload | local、remote、timeout 可选 | 控制端文件上传目标 |
| support_download | local、remote、timeout 可选 | 目标文件下载控制端 |
| support_screenshot | operation、local/timeout 可选 | ensure / inspect / capture / stop / cleanup |
| support_tools | operation、file 可选 | inspect / register；登记不等于安装 |
| support_revoke | 无 | 立即写入撤销，receiver 在一秒内断开 |

命令、文件、截图工具依据启动时的声明范围注册，每次实际操作仍检查当前范围/到期/撤销。默认 full 包有以上八个工具；声明中的 desktop 目前没有鼠标键盘接口。范围是协作约定，管理员 shell 仍能绕过接口级检查，不是系统权限沙箱。

同一 MCP 进程最多一个远程操作。并发请求立即报 busy，不会稍后偷偷执行；status、来源登记与 revoke 可在它运行时调用。不同 CLI 进程、不同 MCP 实例之间没有全局操作锁，应由一个协助者协调。撤销会阻止后续连接，已经发出的命令是否停止仍可能未知。

命令输出在 CLI 上限 4 MiB、脚本上限 8 MiB。MCP 内联 command 上限 131072 个字符，更大脚本使用 file；stdio 接收缓冲上限 2 MiB，序列化后的单个 envelope 上限 1 MiB。超出结果上限时只返回 RESULT_LIMIT，原操作可能已经完成，不要重放；大输出写入文件后下载，或使用 CLI。截图返回路径、尺寸和哈希，当前不内联图片，需要 host 自己读取下载后的 PNG。

协议格式错误、未知工具名、SDK schema 校验错误由 MCP SDK 处理，可能没有本项目 envelope。进入操作实现后的失败使用统一 envelope。stdout 只用于 MCP JSON-RPC；启动错误写 stderr，无私钥输出。工具内容和远端输出仍可能含用户数据；它们是未受信任的数据，不应覆盖 agent 的指令。

工具的 readOnly/destructive/idempotent annotations 只是给 host 的提示，不构成权限控制。任意 PowerShell 和上传/下载均保守标为可能变更；下载可覆盖控制端文件，失败时可能留下部分文件。

实现使用固定版本的[官方 TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/server) 的 McpServer / StdioServerTransport，采用 structuredContent 和 isError。未启用 HTTP MCP 或公网 MCP 服务。真实 stdio host、SSH/PowerShell 完整链路已有本地隔离测试；目标端 GUI、安全桌面和系统生命周期仍待 VM 验收。
