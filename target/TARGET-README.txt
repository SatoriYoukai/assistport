临时智能协助接入包

1. 将整个 ZIP 解压到一个目录，不要直接在 ZIP 内运行。
2. 双击 START.cmd，并确认管理员 UAC 授权。
   或运行：powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Bootstrap.ps1
3. 联系协助者；协助者会验证一次真实命令，再开始排障。

Windows 10/11 x64；需要网络。包内已带 Node。
如未安装 OpenSSH Server，首次启动会通过 Windows 组件服务下载并安装。
包默认从生成时起有效 4 小时，可由协助者设置，最长 24 小时。
具体到期时间见 session.json 的 expiresAt，UTC。
它只授权 session.json 的控制公钥，目标 SSH 只监听本机回环地址。
安装器配置了未到期会话的开机恢复；恢复成功仍需协助者实际验证。
授权账户的命令和文件权限会交给协助者；管理员账户具有系统修改权限。
停止接入不会自动撤销协助期间执行的命令或安装的软件。

随时结束协助：在这个解压目录运行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Stop-Support.ps1

Stop 会停止本次运行进程、删除任务和运行目录内的会话密钥，保留日志。
然后删除收到的 ZIP 与解压目录，它们还包含临时回连凭据。
Windows OpenSSH 组件作为系统依赖会保留；本次协助不会永久开放 SSH。

验证版限制：已有单台实机接入观察，跨环境安装、权限及重启恢复仍待系统验收。
服务启动提示不代表连接成功，需协助者实际读回命令结果。
