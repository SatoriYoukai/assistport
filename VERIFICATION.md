# 验证范围

更新：2026-10-24。必须区分本地集成测试、原型实战观察与仍待验收的能力。

## 2026-10-24 源码发布前检查

按现有依赖允许的版本范围，将 Zod 更新至 4.6.7、body-parser 更新至 2.4.0、fast-uri 更新至 3.1.9，并更新其所需的 qs 6.16.1。未扩大 SDK、SSH 或 WebSocket 的版本范围。干净执行 `npm ci --ignore-scripts` 后，完整 `npm test` 自然退出且退出码为 0；当日 `npm audit --omit=dev` 报告 0 个已知漏洞。该结果反映检查时的软件依赖数据库，不等于独立安全审计或对未知漏洞的保证。

首次开源内容限定为源码、文档、许可证和测试。生成的会话包、密钥、目标机器资料、截图、日志、工作目录和第三方可执行文件不属于发布内容。

首次云端运行暴露两个路径兼容性问题，均保持原测试要求后修复：Node.js 22.23.4 在 Windows 上的原生递归复制会把中文目标目录写成乱码目录，打包改为逐目录、逐文件复制；官方 Node.js 22.23.4 与本机 24.18.0 均通过实际打包和最终 ZIP 的 PS5 CheckOnly，测试显式传入当前 Node 路径，避免误用 PATH 中的其他版本。测试另核对中文及单引号目录、二进制内容、空目录和拒绝自包含复制。

另一处仅在测试 SFTP 服务：Windows PowerShell 将临时目录的 8.3 短路径展开成长路径后，原字符串前缀检查错误拒绝了目录内文件。fixture 现先规范化实际路径，再检查目录范围；原版在实际短路径 TEMP 下复现相同失败，修复版在同环境完整集成测试通过。此修复没有放宽产品的路径权限或跳过大脚本传输检查。

## 2026-10-21 真实首次接入暴露的问题

一台教室 Windows 11 在 Bootstrap 读取带中文 operatorLabel 的 BOMless UTF-8 session.json 时失败。旧打包测试只使用英文 label，未执行最终 ZIP 中的 PS5 Bootstrap。此遗漏已在本机 ACP936 的 Windows PowerShell 5.1 原样复现；不能再用“本地 SSH 测试通过”代替包入口验收。

JSON 统一由明确 UTF-8 的安全 reader 读取；损坏输入仅报固定错误，不把整段配置带入控制台或 runner 日志。截图脚本保留独立 reader，以免依赖低权限桌面用户读不到的私有根脚本。已处理 PS5 子进程继承 PS7 模块路径造成的 Utility/Security 加载失败。

打包现增加强制门槛：压缩最终 ZIP、展开该 ZIP，再以原生 powershell.exe 执行其 Bootstrap -CheckOnly。测试使用中文 label、中文含单引号目录，并验证 native stdout 解码。该检查证明读取、运行时 hash/签名和已附带 SSH 的完整性，不执行系统组件安装、提权、任务或真实接入，不声称目标机器安装已验收。

目标应用读取修复后继续到 Add-WindowsCapability，报服务未启动；不能仅凭截图确定具体依赖服务。为避开系统组件安装，增加可选自带 SSH 路径，固定 manifest hash、逐文件 hash 与 Microsoft 签名；没有静默启动/修改 Windows Update。此次取自 Microsoft PowerShell/Win32-OpenSSH 的 10.4.0.0p1-Preview，随包保留 LICENSE/NOTICE。它是上游预览发行，不是 Windows 内置组件的兼容性保证。

小修复 ZIP 已实际解压，并应用到原始交付 ZIP 的全新解压目录，两次运行均通过 PS5 CheckOnly；不包含会话凭据。真实便携 daemon 在本地非管理员账户已完成监听/公钥/PowerShell 验证，但该 fixture 因开发沙箱给授权文件附加 SID 使用了 StrictModes no；产品配置仍使用严格默认值。该本地 fixture 本身不证明 SYSTEM 任务或正式目录 ACL 可用，独立目标的实际结果另见下文。

同一 OpenSSH 10.4 原生 daemon 的本机 fixture 已经通过公网 WSS 入口，完成真实 operator exec 和随机 nonce probe；stderr 与 `-E` 文件日志两种启动方式均通过。该 fixture 以本机非 SYSTEM 身份运行并使用上述 StrictModes no，不能覆盖 SYSTEM 创建预认证虚拟账户的分支。核对 10.4 官方源码后，bootstrap 为 runtime 中已校验的 `openssh` 目录及其后代增加 Authenticated Users 的 ReadAndExecute，供低权限 sshd-auth 加载 EXE/DLL；session 根、session.json 和私钥不放宽，CheckOnly 不设置 ACL。真实文件 ACL fixture 已验证新增 RX、目录继承、SYSTEM/Admins 原权限保留、父目录和模拟私钥不变。

随后在一台独立 Windows 11 Pro（build 22631、Windows PowerShell 5.1）上，SYSTEM runner 已建立公网 WSS 回连，但管理员 SSH 握手未完成。为便携 `openssh` 应用目录补充可继承的 Authenticated Users RX 后，2026-10-21 09:27（北京时间）的随机 nonce probe 以 `authenticated_command_completed` 成功结束，耗时约 1.9 秒；真实 exec 进一步返回系统/PowerShell 版本并确认当前命令账户具有管理员权限。由此已验证该目标当前 SYSTEM runner、便携 SSH 正式目录 ACL、严格默认配置下的真实管理员 SSH 接入及本次权限修复效果。

同一目标随后通过真实 SFTP 上传、下载 65,536 字节随机二进制，SHA-256 一致，远端测试文件校验后删除。内置 screenshot ensure 经真实交互计划任务取得 1920×1080 PNG，下载哈希校验成功，并目视确认当前桌面内容。此结果验证该目标当前已登录桌面的单次截图，不代表鼠标键盘操作、锁屏、UAC 安全桌面、重启恢复、到期清理或跨环境兼容已经验收。实际截图与机器身份保留在私有工作目录，不进入开源源码。

该独立 Windows 11 教室目标存在 PNS 管理组件。经用户授权执行一次正常重启（shutdown /r /t 0，未使用 /f）：事前 C 盘公共目录和 D 盘各放置一个 135 字节、SHA-256 相同的标记；重启后用户运行只读校验脚本，回报 C 标记 MISSING、D 标记 PRESERVED 且哈希一致，临时接入也未恢复。此结果仅证明本次 C 测试文件消失、D 测试文件完整保留；不能证明整个 C 的保护范围、D 永久不还原或 PNS 的还原周期，也不能把失联直接归因为连接关闭缺陷。重启自动恢复仍未验收。

`tests/encoding.ps1` 实测有/无 BOM、CP936 同文件失败对照、中文及含单引号路径、无效 UTF-8 和损坏 JSON，五个实际脚本均在副作用前安全失败，stdout/stderr/runner 日志不含哨兵。`tests/portable-ssh.ps1` 在显式提供已审核发行目录时，验证真实签名、固定 manifest、文件篡改和缺失时拒绝，以及隔离目录中的实际应用文件 RX ACL 边界；不安装或修改系统服务，不模拟 SYSTEM 登录。

本轮关闭处理修复后的回连程序，已再次以本机原生 OpenSSH fixture 经公网 WSS 完成真实 exec 和随机 nonce 校验。该 fixture 的非 SYSTEM 身份和 StrictModes no 限制仍如前述；此结果不代表独立目标自动重连、重启或休眠恢复已实测。

## 本地集成测试

`npm test` 用 ssh2 模拟目标 SSH 服务，实际执行 Windows PowerShell；目标与控制端在本机，以 TCP 和 WebSocket 分别建立反向 SSH。

覆盖：拒绝无凭据 WebSocket、中文 stdout、远端异常和退出码、随机二进制 SFTP 传输、限制转发地址与端口、禁止 receiver 普通命令执行、双侧主机密钥不匹配拒绝、撤销拒绝重连、过期断开。新增覆盖：已登记后断线仍显示历史登记，probe 失败，重新连通后 probe 成功。

主机身份不匹配用例使用已通过解析和公私钥匹配校验的另一把密钥，并检查身份错误码，避免把无效密钥的格式错误误算为主机验证成功拒绝。

本轮新增：测试服务强制拒绝超过 8191 字符的命令，仍可执行大型中文脚本；临时目录包含中文与单引号，脚本正常返回、异常和显式 exit 7 后均清理成功。另覆盖 staging 超时报未知结果/清理状态、无自动重跑；CLI 面对不发送 SSH 握手的连接按总 deadline 退出，不出现未捕获错误。

`tests/tunnel-lifecycle.js` 使用真实 ws 和 ssh2 流，重现 WebSocket 关闭后 SSH 只发 end、不发 close 且停止 keepalive 的状态。修复后已验证当前连接结束、实际 CLI 经既有退避后重新接入，以及 WebSocket 打开前、SSH 握手、登记和等待转发响应期间断开均及时失败；不是以手工发出事件替代协议测试。还验证已接受通道发生 TCP 重置后可再开新通道、192 KiB 尾部数据完整及双向关闭清理。

慢读检查还发现，正常 TCP 关闭时直接销毁 SSH channel 会截断等待 SSH 窗口的写入。现以排空屏障后发送 EOF、双向 EOF 后关闭的方式处理正常结束，异常和外层断线仍立即回收。真实 receiver 与 target 回连组合已验证双向各 8 MiB 随机数据：接收端先暂停 500 ms、每块再暂停 2 ms，最终长度及 SHA-256 一致，上传收到 TCP EOF 后仍能返回响应；另在活动传输存在背压时断开外层 WS，确认活动连接回收并可重新接入。

同一测试另启动独立子进程中的真实 receiver，完成本地凭据鉴权、登记和转发，正常关闭 WebSocket 后确认反向端口释放、同会话重新接入成功；receiver 关闭后子进程自然退出，未使用 process.exit 或 unref 隐藏残留连接、计时器。本轮完整 npm test 与最终版本独立 integration 均自然退出、退出码为 0。此为本地关闭与回收验证，未重启运行中的公网 receiver，也未据此宣称真实受助电脑的自动重连已验收。

`tests/log-reader.ps1` 保持日志写入句柄打开，验证共享读取；在独占锁下验证诊断失败不会变成终止错误。此测试不模拟完整 UAC/修复生命周期。

本机 Node 24 测试通过；Node 22/24 GitHub Actions 配置已加入，云端执行结果以仓库的 Windows checks 工作流为准。

`tests/package.js` 验证默认 full 声明、协助者标签输入、两端声明一致、显示/日志脚本和许可证打包，以及目标包不含控制私钥与 receiver 私钥。WPF 会话信息窗口已在本机渲染并目视检查；没有在受助电脑部署此新窗口。Bootstrap 桌面计划任务、显示文件 ACL、停止按钮 UAC 与结束清理仍待独立 Windows VM 验证。

`tests/capabilities.ps1` 在隔离目录中运行实际管理逻辑，用任务/权限/进程替身替换 Windows 副作用。验证首次新图片、安装复用、历史 inspect、stop/resume、桌面用户变化、任务被修改、忙碌/超时不重放、PID 身份核对、管理员/范围/到期拒绝、修改文件保留与图片保留。图片由固定 PNG fixture 提供，没有读取真实屏幕，也没有注册本机任务；不能证明原生桌面、真实 ACL 和任务回收可用。

`tests/capability-client.js` 通过模拟传输验证图片路径、目标会话绑定、SHA-256 校验与损坏时保留原本地文件。`tests/tool-registry.js` 验证来源/审核/清理信息必填、声明范围、不可静默换来源、过期拒绝以及登记不会标为已安装。外部工具未被下载或执行。

`tests/capture-backend.ps1` 编译截图脚本中的原生桌面检查代码，加载绘图程序集并编码离屏单像素 PNG；没有调用读取真实桌面的函数，不替代锁屏/交互会话/DPI 实机验证。

`tests/operation.js` 验证统一 envelope、参数在连接前拒绝、范围/到期/撤销错误码、非零退出保留输出、未知结果、取消、清理不完整和 CLI 错误 JSON。`tests/mcp.js` 用官方 SDK 客户端启动真实 stdio 子进程，验证协议握手、八个工具、schema、单会话绑定、结构化结果、无私密配置泄露、撤销和 stdout 无额外日志；另用内存传输验证并发请求未排队、revoke 绕过忙碌状态、范围缩减与结果大小限制。

SSH 集成测试还通过 MCP stdio 子进程执行真实 PowerShell，验证 probe、中文输出、退出码 7、执行阶段超时和取消后的未知结果。测试 SSH 服务只在本机隔离目录运行，没有接入受助者电脑。截图 MCP 接口复用已有模拟生命周期测试，没有捕获真实目标屏幕；真实 agent host 的配置与图片消费未验收。

打包测试使用目标包自带的 Node 加载回连程序及其依赖，确认不携带 MCP SDK。当前安装的依赖已重新进行 npm audit；发布时仍需重新检查，测试通过不等于独立安全审计。

上述本地测试不覆盖系统组件安装、UAC、真实 SYSTEM sshd、桌面会话或启动计划任务。独立目标的当前 SYSTEM runner 与真实管理员 SSH 已按前文单独验证；重启启动、桌面及结束清理仍未据此验收。

## 原型实战观察

此前原型曾通过公网 WSS 回连一台独立 Windows 电脑，完成管理员 PowerShell、文件上传下载和诊断操作。暴露并处理了 host key 文件 ACL 和 WebSocket 流创建时序问题。这是一次环境验证，不是全版本兼容性证明。

该目标重启或休眠后通道失联，同一会话 repair 被锁定日志阻断；继续 repair 后出现私钥缺失。旧 runner 发起的异步清理存在跨越修复重建的竞争窗口，现已取消该异步清理，但原故障的每个时序环节未完整证实。更换带修复的新包后真实命令成功，后续诊断正常。不能据此宣称重启自动恢复已经验收。源码目录不包含该电脑的会话、身份、截图或诊断结果。

## 尚待验证

干净 Windows VM 首装、无网络组件源、标准用户权限、管理员权限、重启/休眠恢复与到期清理、手动 Stop 完整清理、GUI/锁屏/UAC边界、入口稳定性、供应链发布与独立安全复审。

依赖漏洞检查需要随发布重新运行；不使用旧 audit 结果声明当前安全。
