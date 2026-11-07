# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持原生 Windows、macOS 和 Linux。需要 Node.js 24 或更新、Git，以及一个已经登录的命令行 Agent；macOS/Linux 还需要 curl。Windows 使用系统自带的 PowerShell 5.1、任务计划程序和 Windows Script Host（wscript）。

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.ps1 | iex
```

默认安装在 `$env:USERPROFILE\.agent-autoloop`，命令目录加入当前进程及用户 PATH。Windows 10 和 11 都能装，不需要管理员：后台服务是当前账号自己的登录任务。Windows 服务在本人登录后于后台常驻、不开窗口，退出 10 秒后自动重启，注销后停止；通过 SSH 管理时也可用 `service install`，任务会在 Windows 已登录的会话中运行；Codex 0.167 的原生沙箱在 OpenSSH 会话中会出现 runner pipe-in 超时，本机登录会话正常，见 [Codex 已知问题](https://github.com/openai/codex/issues/37722)。CI 或普通命令测试用 `--no-service`，再运行安装器打印的完整命令启动 `up`。桌面通知只在同一登录会话显示。

本地仓库安装示例：

```powershell
$env:AGENT_AUTOLOOP_REPO = 'C:\code\agent-autoloop'
& 'C:\code\agent-autoloop\install.ps1' --agent codex --no-service
```

系统不允许运行本地脚本时，可仅为这一条命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\code\agent-autoloop\install.ps1 --agent codex --no-service`，不修改全局执行策略。安装其他参数与下面的 macOS/Linux 相同。

给 Windows 写带中文的 PowerShell 脚本（比如轮询脚本，或包一层 Agent 的脚本）要存成带 BOM 的 UTF-8：PowerShell 5.1 按本地代码页读不带 BOM 的文件，中文会乱，接着报语法错误。

WSL2 仍按 Linux 安装；常驻服务需要发行版开启 systemd，没开则加 `--no-service`。WSL2 的桌面通知不会发送到 Windows 桌面。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的 macOS/Linux 命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。中台在后台启动 Agent，桌面应用里能用的浏览器和电脑操作它不一定用得上（比如 Codex 应用里的 Chrome，后台的 `codex exec` 用不到）；要它操作网页，照[浏览器接入](docs/plugins.md#浏览器接入)配好，再用后台的启动方式实际跑一次。

安装和 `agent-autoloop update` 都装最新的 Release，那是通过了全部检查的版本，`main` 上还没发布的改动要等下一个 Release。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；这时安装器克隆的是本地仓库的 HEAD，`update` 也跟着那个仓库走，不看 Release。已经装过时这个变量不起作用，还跟着原来的来源走；要换来源，先运行 `agent-autoloop uninstall` 再装。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -Q -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。macOS/Linux 的命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时在 macOS/Linux 把数据目录设为 `0700`，Windows 则用 ACL 只允许本人和 SYSTEM 访问，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。Codex 的 Windows 沙箱会给用户目录下的文件夹加上它的账号的读权限，数据目录也在内；中台启动时收回，在那之前沙箱里的命令能读到主密钥和配置里的密钥。插件另外给每轮的 `context.json` 加这个读权限。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的通知程序或通道，Windows 也不要弹真实通知；不要给已在线的飞书应用再开监听。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

想让用户在飞书里私聊机器人发文字就直接派活，接内置的 `feishu-in` 通道，见[插件说明](docs/plugins.md#只收消息的通道飞书收件feishu-in)。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

Windows 开发检查用 `npm run test:windows` 与 `node scripts/install-smoke-windows.ts`。Linux/macOS 用 `npm run test:quick`（改了 `kernel/`、`protocol/`、`sim/` 时用 `npm test`）、`npm run typecheck`、`npm run format:check`，完整故障检查和性能实测用 `npm run test:nightly`。备份和恢复见[配置手册](skills/agent-autoloop/SKILL.md#日志与恢复)。`master.key` 坏了中台会拒绝启动：从备份恢复；没有备份就删掉它，重启会生成新的，已发出的卡片链接和正在跑的轮次会失效。
