---
name: agent-autoloop
description: 配置 Agent 自动化中台：加规则、接新的事件插件、接新的 Agent、接新的通道（飞书、QQ、钉钉、企微……）、写处理手册、部署到服务器、多台电脑。用户说“有事的时候让 Agent 自己处理”“每天几点让 Agent 做某事”“接一下 GitHub / 告警 / 某个系统”“换一个模型”“在飞书里批”“加一台电脑”时用。
---

# Agent 自动化中台

协议全文在 `docs/protocol.md`，这里是怎么做。程序在 `~/.agent-autoloop/app`，规则在 `~/.agent-autoloop/rules.json`，配置和密钥在 `~/.agent-autoloop/config.json`。

## 看情况、回答

`agent-autoloop status` 列出谁在线、等用户什么、在做什么、做过什么，还有按完成时间统计的今天和最近 7 天的轮数、Token 和费用（同一轮重试的已报用量相加，没上报的轮数会写出来）。`agent-autoloop status --json` 输出 `/v1/state` 的原样结构，给脚本和看板用。`agent-autoloop answer <卡片> <序号>` 回答，`agent-autoloop resolve <卡片> <结果>` 结案，`agent-autoloop stop <第几轮>` 停掉一轮，等整个进程组退出才报告已停。

续接会话也只算这次新增的用量。`~/.agent-autoloop/worker/usage/` 存着相减要用的累计值，没有记录的续接（比如删了这个目录）这次不报 Codex 的 Token 和 Claude Code 的费用，下一次恢复正常。本人打开链接在同一个会话里接着聊用掉的量，会算进下一次续接。旧回执不重算。

这里没有网页。用户想要一个页面看全局，就替他写一个：读 `GET /v1/state`，密钥是 `config.json` 的 `owner`，要跟着变化就从状态里的 `seq` 接 `GET /v1/stream?after=<seq>`，请求见 `docs/protocol.md` 的「本人」一节。

## 改规则

改 `rules.json`，运行 `agent-autoloop check`。几秒内生效；写错了旧规则继续跑，并推一张卡片说错在哪。`agent-autoloop rules explain` 列出本机规则生效的样子和下次定时，`agent-autoloop emit <类型> --dry-run` 预演一条事件会派给谁，两个都只看本机的 `rules.json`，不连接中台。尚未领取的任务在领活时一起更新 Agent、目录和权限；已领取任务的 Job 配置与接单程序保留到这次执行结束。

每条规则回答五个问题：什么事件（`when`），交给谁（`to`），在哪（`cwd`），照什么做（`skill`、`prompt`），要不要告诉用户（`tell`，默认只在有卡片时）。

```json
{ "name": "处理 issue", "when": { "source": "github", "types": ["issues.opened"] }, "to": "claude", "cwd": "~/code/app", "skill": "handle-issue", "parallel": 3 }
{ "name": "早报", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "写今天的早报。" }
```

- 同一个对象的事件要分开处理、互不等待，就写 `parallel`。一台接单程序同时跑几轮还受 `config.json` 的 `worker.capacity` 限制，默认 2，要多跑就一起调大。
- 对话这类要马上回的活，不想排在批量的长任务后面：把批量的规则都写进同一个 `group`，`parallel` 写得比 `worker.capacity` 小，留下的名额长任务占不了，对话来了直接领。比如 `capacity` 是 4，批量那组写 `"group": "batch", "parallel": 3`。同一组的规则 `parallel` 写成一样的。
- 同一个对象的新事件要接着上一轮的会话（比如同一个对话的后续消息），就写 `"resume": true`；默认每次开新会话。上一轮被停掉、可能还在跑或者换了 Agent 时开新的。不写 `parallel` 时整条规则的事件都接同一个会话。
- 要停一条规则，用 `agent-autoloop pause <规则> --reason …`（到点自动恢复加 `--until`），恢复用 `resume <规则>`，现在就跑一轮用 `run <规则>`；不用为了停规则去改 `rules.json`。
- 改规则前可以先写成草稿，用 `agent-autoloop check <草稿>` 校验，不影响正在跑的中台。
- 默认的先问清单是 `askFirst`，用户说什么事必须先问他，就改这里。
- 用户在别的地方定时跑的任务（Claude、Codex 应用里），写进 `elsewhere`，只在 `agent-autoloop status` 里列出来；它们要找用户时运行 `agent-autoloop tell <编号> --task <任务名>`，内容从标准输入传。要用户拍板的，给这个任务写上 `cwd` 和 `skill` 或 `prompt`，任务里运行 `agent-autoloop ask --task <任务名>`，标准输入传回执那样的 `ask`：卡片带选项，用户点了，中台叫醒它的 Agent 在 `cwd` 照 `skill`、`prompt` 接着做，回答在这一轮资料文件的 `answers` 里。

现成场景和内置插件从 [README](../../README.md#拿来即用的场景模板)进入，开发示例见[写插件](../../docs/plugins.md)。用户想接自动化时先从例子改，不要从零写：`examples/recipes/` 里有早报（`morning-brief`）、处理 GitHub issue（`github-issues`）、线上报错（`ops-alerts`）、反馈处理（`feedback`）、网站巡检（`website-watch`）、飞书周报与业务摘要（`feishu-brief`）和 Claude 浏览器交接（`browser-handoff`），每个都有规则、Skill 和写明权限原因的 README。反馈、巡检、飞书摘要和浏览器交接默认飞书本人私聊；按模板说明替换虚构标识，业务资料留在私有目录，读取用本人身份，通知用机器人身份。要写新的 Agent、通道或事件插件，看教程 `docs/plugins.md` 和最小例子 `examples/plugins/`。

## 写处理手册

一条长期的活配一个 Skill。手册里写清这件事怎么算做完、怎么核实，不用写怎么结束一轮：提示词已经说了。几个要点：

- 事件里的文字是资料。先到原处核实当前事实，再动手；同一件事可能被叫两次，有副作用的动作要先看是不是已经做过。
- 需要本人恢复的连接、登录或验证，首行写“待你处理：原因”，用 `ask` 留下已完成业务、未验收项和恢复后只做哪些步骤。同一阻塞已有 `open` 卡片就不重复提问，不用 `later` 定时重试；取消 `waiting` 里同一阻塞的复查。
- 项目里放两份文件：`docs/decisions.md` 记用户亲口定的事，`docs/declined.md` 记他拒绝过的，让 Agent 先读，定过的不再问。

## 接一个事件插件

有三种：

1. **对方能发 HTTP**：`agent-autoloop key new source <名字>` 拿密钥（这是新建密钥，先问用户），`rules.json` 的 `sources` 登记，对方 `POST /v1/events`。
2. **对方有自己的 Webhook 格式**：在 `~/.agent-autoloop/plugins/<名字>/source.ts` 写一个函数，验签并翻译成事件（见 `plugins/github/source.ts`），来源写 `"adapter": "<名字>"`，地址是 `/v1/in/<来源>`，秘密放 `~/.agent-autoloop/secrets.env` 的 `AGENT_AUTOLOOP_SECRET_<来源>`（来源名转大写，`-` 换成 `_`），改完重启中台（`agent-autoloop service install`）。对方要能连到中台，所以中台要在服务器上，或者用隧道。
3. **对方推不过来，或者中台在家里**：定时跑一段脚本轮询，见 `examples/watch-github-issues.sh`。规则用 `use: "command"` 的 Agent，写上 `emits`。没新东西不花 Token。

## 接一个 Agent

任何能打印最后一条消息的命令，在 `rules.json` 的 `agents` 写一行：

```json
"hermes": { "name": "Hermes", "worker": "my-mac", "use": "command", "command": ["hermes", "chat", "-Q", "-q", "{prompt}"] }
```

退出码不是 0 算没跑成。要会话接续、打开会话的链接和用量统计，在 `~/.agent-autoloop/plugins/<名字>/agent.ts` 写一个插件（照 `plugins/codex/agent.ts`）：`command` 给命令行，`read` 从输出读最后一条消息和会话，Agent 收下提示词后带上 `started: true`（否则干到一半断了会开新会话重做），`link` 给链接。

`access` 默认 `edit`，专用插件翻译成对应 CLI 的权限；`command` 只传参数，不替任意程序限制权限，按该 CLI 文档配置。要完整权限、不审批的话写 `full`，先和用户说清楚。

内置的 Claude Code、Codex、DeepSeek Harness 要走第三方网关、代理，或者启动前要先设好环境变量：写一个小脚本，设好变量再 `exec claude "$@"`（Codex、DSH 照此换成 `codex`、`dsh`），Agent 里写 `"program": "脚本的绝对路径"`。插件照旧解析输出、续接会话、统计用量，只是启动的是这个脚本；不用改成 `use: "command"`。令牌放在脚本读的文件里，不写进 `rules.json`。接单程序启动 Agent 前会去掉继承来的 `CLAUDE_CODE_*` 变量，要用的写在脚本里。`agent-autoloop doctor` 也用这个脚本检查登录。

```json
"deepseek": { "name": "Claude Code（DeepSeek）", "worker": "my-mac", "use": "claude", "program": "/Users/me/.agent-autoloop/bin/claude-deepseek.sh" }
```

第三方仓库根目录放 `agent.ts`、`channel.ts` 或 `source.ts`，用 `agent-autoloop add <git 地址>` 安装到 `~/.agent-autoloop/plugins/<仓库名>`。仓库名转成小写就是插件名，规则的 `use` 写它；只能有小写字母、数字和 `-`，不合要求的 `add` 会拒绝。同名本机插件优先于内置插件，不自动更新。插件是可信代码，先读再装。

Windows 的 `cwd` 可写 `C:/code/project`、JSON 转义后的 `C:\\code\\project`、UNC 路径或 `~/code/project`，以接单电脑为准。`command` 支持可执行文件、PowerShell 脚本和 npm 的 JS 入口包装；其他 `.bat`/`.cmd` 请换成可执行文件或 `node script.js`。Windows 按 PATH 找程序，不加载 Unix 登录 shell。

一轮最长跑多久写 `timeout`，单位是分钟，默认 180。

ACP 用 `use: "acp"` 和 `command: ["ACP 服务程序"]`，比如 Gemini CLI 是 `["gemini", "--acp"]`、OpenCode 是 `["opencode", "acp"]`，支持 v1 的会话新建、恢复、文字与一次性权限请求；先在该 Agent 自己的 CLI 登录。`access` 只管 Agent 主动来问的操作，规范允许它不询问就执行，要限制得用它自己的模式（比如 `command` 里写 `env INITIAL_AGENT_MODE=read-only …`）；`model`、`effort` 不生效。普通命令接法与实测支持范围见 README。

DeepSeek Harness 用 `use: "dsh"`，要 0.2.2 或更新（`npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local`，不放行这三个包的安装脚本，装完一跑就出错），能续接原会话、上报 Token（不报费用），报 `MISSING_CREDENTIAL` 时把密钥放进环境变量，`access` 对应它的权限档位；旧版用 README 里的普通命令接法。没有可打开的桌面链接。

Claude 主任务要委托 Codex 操作网页时，从 `examples/recipes/browser-handoff/` 配置已验收的入口、目标与允许操作，保留返回的 Codex 子会话编号；受阻由主任务交 `ask`，恢复后只续办网页步骤。入口调用模板不提供浏览器连接，也不修改桌面应用或授权。

网页任务使用 Agent 已配置的浏览器工具。需要专用入口时，在规则的 `prompt` 或 `skill` 写明已有命令和会话接续方式，只交网页步骤，业务和回执仍由主任务负责。不能假定后台 CLI 已接通桌面浏览器；用同一后台方式验收页面和接续，见 `docs/plugins.md` 的「浏览器接入」。

## 接一个通道

配置在两处：`rules.json` 的 `channels` 登记（`answerers` 是谁能回答，没写时通道里谁都能回答，`doctor` 会提醒），`config.json` 的 `channels` 写密钥和选项。`agent-autoloop key new channel <名字>` 拿密钥（先问用户）。改了 `config.json` 要 `agent-autoloop service install` 重启。默认每张卡片发到所有通道；某条规则的卡片只想发到某几个通道，在这条规则里写 `"channels": ["feishu"]`。

**桌面通知**：新装的中台默认开着（`plugins/desktop/channel.ts`），两处各有一个 `desktop`。卡片第一次发送时，macOS 用 `osascript`、Linux 用 `notify-send`、Windows 用 PowerShell 系统托盘通知弹一条通知，标题为“Agent 问你一个问题”，正文是卡片标题和“运行 agent-autoloop status 查看”，不能在通知上回答。没有图形会话时安静跳过，问题仍在；通知命令失败时报告失败，不会让中台退出。接了别的通道可以留着它；不想要就把两处的 `desktop` 都删掉，再重启。以前装的中台不会自动加上它。

**飞书**：用官方的 `lark-cli`。`npm i -g @larksuite/cli`，`lark-cli config init --new` 建一个应用（用户扫码），在开发者后台给应用开机器人能力，并订阅卡片回传交互（长连接）。然后：

```json
// rules.json
"channels": { "feishu": { "name": "飞书", "answerers": ["ou_用户的 open_id"] } }
// config.json
"channels": { "feishu": { "key": "…", "user": "ou_用户的 open_id" } }
```

同一个飞书应用的卡片点击只能有一个监听，只在一台电脑上跑。

**飞书私聊提需求**：想让大家在飞书私聊机器人发文字就派活，用内置 `feishu-in` 通道，见[插件说明](../../docs/plugins.md#只收消息的通道飞书收件feishu-in)。要在开发者后台再订阅 `im.message.receive_v1`（长连接）并开机器人收消息权限；`config.json` 里 `users` 写允许提需求的人，没写时一条私聊都不收。它只收消息不投卡片，和上面的 `feishu` 通道配同一应用各司其职，都要只在一台电脑上跑。

**只会发文字的（钉钉、企微的群机器人，Slack、Discord 的 Webhook）**：用 `plugins/webhook/channel.ts`，`config.json` 的通道项写 `"use": "webhook"`、`"platform": "dingtalk"` 和 `"url": "已有的 Webhook 地址"`；平台也可选 `wecom`、`slack`、`discord`。别的平台只要收 JSON POST 也能接：不写 `platform`，写 `url` 和带 `{text}` 的 `body`，比如 Telegram 写 `"url": "https://api.telegram.org/bot<机器人令牌>/sendMessage"`、`"body": { "chat_id": "…", "text": "{text}" }`。`rules.json` 里写 `"links": true`，卡片链接本身就能回答；`config.json` 的 `hub.publicUrl` 要配成手机或电脑能打开的地址。

**有按钮的新通道**：在 `~/.agent-autoloop/plugins/<名字>/channel.ts` 写一个，照 `plugins/feishu/channel.ts`：循环领卡片、发或改、报告；收到点击转给 `hub.answer`。协议在 `docs/protocol.md`，用别的语言写也行，只要会发 HTTP。

## 交付流水线

需要这台接单电脑已有 `gh` 登录和审查程序。`delivery` 进程只执行本机插件和 main 指定的审查命令，PR 不检出、不在本机跑代码。先把项目的 `ops/delivery.json` 和审查要点放到 main：

```json
{
  "repo": "owner/app",
  "internal": ["docs/**/*.md"],
  "check": { "workflow": "check.yml", "job": "check" },
  "ship": { "workflow": "ship.yml" },
  "review": { "points": "AGENTS.md", "status": "agent-review", "xhigh": ["src/auth/*"] },
  "health": {
    "url": "https://app.example/health",
    "field": "commit",
    "pattern": "(?P<sha>[0-9a-f]{40})",
    "require": { "ok": true }
  }
}
```

`AGENTS.md` 要有 `## 审查要点`。`review.command` 可用命令数组替换审查程序：提示词从标准输入读，`{input}` 替换成文字差异文件，标准输出必须是 `{"findings":[{"title":"文件:行号和问题","text":"触发条件和后果"}]}`；没问题交空列表。默认 Codex 忽略用户配置、禁用记忆，只读单独的审查快照。`admin_merge` 默认为空；只有 main 明确列出的 PR 作者才能使用管理员合并。没有线上服务的项目可以省略 `health`，回执会明确写只完成合并。

`check.job` 写 job 的名字；矩阵 job（名字像 `check (ubuntu-latest)`）算同一个 job，每一项都要成功。检查工作流的触发类型要带 `ready_for_review`：草稿转 ready 后，只接受这之后新跑的一次检查，而 `pull_request` 默认不在转 ready 时触发。写成 `on: { pull_request: { types: [opened, synchronize, reopened, ready_for_review] } }`。

规则示例（把绝对路径、接单电脑和仓库改成自己的）：

```json
{
  "sources": { "github": { "name": "GitHub" } },
  "agents": {
    "poll": {
      "name": "查看交付标签",
      "worker": "mac-mini",
      "use": "command",
      "command": ["node", "/绝对路径/agent-autoloop/plugins/delivery/poll.ts", "owner/app"]
    },
    "delivery": { "name": "交付", "worker": "mac-mini", "use": "delivery", "command": ["owner/app"], "timeout": 35 }
  },
  "channels": {},
  "rules": [
    {
      "name": "查看待交付",
      "when": { "cron": "*/2 * * * *" },
      "to": "poll",
      "cwd": "/已有的工作目录",
      "prompt": "查看项目交付标签",
      "emits": { "source": "github", "types": ["pull_request.labeled", "issues.labeled"] }
    },
    {
      "name": "交付",
      "when": { "source": "github", "types": ["pull_request.*", "issues.labeled"] },
      "to": "delivery",
      "cwd": "/已有的工作目录",
      "parallel": 2,
      "prompt": "按 main 的项目设置完成交付"
    }
  ]
}
```

轮询无需配置新的 Webhook 或密钥，事件编号由标签记录与 PR 提交组成，重复读取不会重新派发；也可以直接接现有 GitHub 来源。事项按 `owner/repo#编号` 分开，`parallel` 控制并发。打 `deliver` 进入流程；同时打 `deliver-review` 只审查，在等待检查期间加上也会阻止合并；`deliver-attended` 表示有人盯着，发现问题只写回执、不另发通知。审查发现问题后，同一个提交不再审第二次，修复后推新提交才重新审查。普通 issue 打 `ask-owner` 会变成一张问题卡片，回答后去掉标签；不替你在 GitHub 发评论。

项目 Ship 只在 main 的 push 上运行，检出完整历史（checkout 的 `fetch-depth: 0`），然后调用这个仓库的 Action。把下面的占位提交换成发布后核实的完整 SHA：

```yaml
- uses: KKKKhazix/agent-autoloop/plugins/delivery@<完整提交编号>
  id: scope
- if: steps.scope.outputs.release == 'true' && steps.scope.outputs.superseded != 'true'
  run: ./项目已有的发布命令
```

健康接口返回的版本必须能提取到 Git 提交，并且业务字段满足 `require`。普通运行只允许 HTTPS；`--test-local-health` 和 Action 的 `test-local-health: 'true'` 仅用于明确的本机测试，额外允许 `http://127.0.0.1`。这不让 GitHub 托管 runner 访问你的电脑。

## MCP 与密钥撤销

MCP 客户端的启动程序填 `node`，参数为本机引擎绝对路径 `bin/agent-autoloop.ts`、`mcp`，环境里传 `AGENT_AUTOLOOP_HOME`。支持 stdio 2025-11-25 版，使用本机 `config.json` 已有密钥，不把密钥写进客户端参数。工具按已有身份显示；不自动创建权限。

MCP 服务不区分调用方，都按本人记录（`answer` 记成本人，`emit` 不带层数）。不要把它配进接单程序启动的 CLI 的用户级配置，否则一轮能自己回答自己的卡片。

`agent-autoloop key remove <source|worker|channel|owner> <名字>` 立即收回对应密钥，长轮询和日志订阅也立即失效；已经领到的活仍可用这一轮的独立 token 交结果。

## 放到服务器、加电脑

手机要批卡片、别人的 Webhook 要进来时，把中台放到一台有公网的机器上：

1. 服务器上 `sh install.sh --no-service --command true`（这台不跑 Agent，`--command true` 只是占位，第 2 步把 `rules.json` 里的 Agent 换成真的），`config.json` 里 `hub.listen` 用 `127.0.0.1:3350`（要写成 `主机:端口`，IPv6 用 `[地址]:端口`；只写端口或 `:端口` 会被拒绝，避免意外监听所有网卡），`hub.publicUrl` 写公网地址，去掉 `worker`，再 `agent-autoloop service install`。前面放一个做 HTTPS 的反向代理（Caddy、nginx）。
2. 每台干活的电脑：服务器上 `agent-autoloop key new worker <名字>`，电脑上 `curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh -s -- join https://中台地址 --worker <名字> --key <密钥>`。`rules.json` 的 Agent 写上对应的 `worker`。

电脑不用开放任何端口，它们自己连过去。

服务器上自己写的系统级 systemd unit，名字要和 `agent-autoloop service install` 用的一样（默认 `agent-autoloop`），`doctor` 才认得出。`agent-autoloop update` 不碰它，更新后自己运行 `systemctl restart` 才会用上新版。

## 日志与恢复

Windows 用任务计划程序在本人登录后启动；通过 SSH 管理时仍用这个登录任务运行 Codex，避免它在 OpenSSH 会话中的沙箱启动限制（见 `INSTALL.md`）；`service install`、`service remove`、`update` 同样适用，更新会重启中台。安装见 `INSTALL.md`。

日志：Windows 在 `%USERPROFILE%\.agent-autoloop\logs\up.log`，macOS 在 `~/.agent-autoloop/logs/up.log`，Linux 运行 `journalctl --user -u agent-autoloop`。

接插件先在专用测试中台验证：`agent-autoloop conformance <地址> --config <测试凭据文件>`。文件里的 `keys` 分别放来源、接单程序、通道、本人密钥；`eventType` 匹配测试规则，`answerer` 在测试通道的允许名单内。检查会写事件和卡片，不指向正在用的中台。协议类型在 `protocol/schema.json`。

`agent-autoloop why 42` 查一轮的事件、规则和回执；`GET /v1/stream?after=42` 供本人客户端按序号续读。备份用 `agent-autoloop backup [目录]`，中台运行时也能做；恢复用 `agent-autoloop restore <目录>`，要先停中台。手工备份要一起保留 `hub.db` 和权限为 0600 的 `master.key`；后者推导轮次和卡片链接的 token。

## 版本与卸载

`agent-autoloop --version` 显示版本和提交。`agent-autoloop uninstall` 确认后删除自身程序、链接和服务，规则、密钥和记录保留；`--yes` 只跳过确认。
