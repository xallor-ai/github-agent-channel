# 为仓库选择负责 Agent

从已配对的设备运行下面的命令。新增仓库不改服务端配置，也不重复使用个人 GitHub 令牌。示例使用 Node 24。

## 1. 服务运营者：部署一次服务，邀请设备

按[部署与运维](operations.md)配置 GitHub App、服务端及 HTTPS 入口。App 的安装范围须包含目标仓库，并订阅希望关注的事件。管理员在可信管理入口向设备所有者的 **GitHub 数字用户 ID** 签发邀请。示例中的 URL 是服务端管理入口，而非设备访问的公网地址：

```sh
npm run channel -- admin invite http://127.0.0.1:18896 123456 ./secrets/invite.private
```

管理员凭据通过该机的 `CHANNEL_ADMIN_TOKEN` 注入，不能交给设备。输出文件须不存在；邀请 10 分钟有效，只能消费一次。私下交付邀请文件。设备丢失时，在同一管理入口执行 `admin revoke <channel-url> <device-id>`，按[运维指南](operations.md)核对撤销前的在途发布。

## 2. 设备所有者：连接一次 Agent

运行 `npm run channel -- agent init`，在生成的 `agent.local.yaml` 选择 Channel 地址、`runtime.type` 和 `runtime.agentId`。例如 `openclaw` 加 `github` 对应负责人 `openclaw/github`；ACP 使用本机显式命名的 harness。运行及凭据配置分别见 [OpenClaw](setup.md) 和 [ACP](acp-setup.md)。确保设备凭据目录仅当前用户可访问（Windows 请限制 ACL）。首次配对会创建 `channel.tokenFile`；如使用 `channel.tokenEnv`，由秘密管理工具注入 32 个随机字节的 base64url 编码。

在已登录获邀 GitHub 账号的终端运行：

```sh
gh auth token --hostname github.com | npm run channel -- agent pair ./secrets/invite.private agent.local.yaml
npm run channel -- agent run agent.local.yaml
```

配对只向可信 Channel 提交一次用户令牌，以后使用设备凭据。记下返回的设备 ID；删除已消费的邀请。如果配对响应丢失，保留设备凭据，恢复连接后用只读查询核对。负责 Agent 通过设备出站领取任务，无须对公网开放端口。

## 3. 仓库管理员：绑定仓库

设备配对的 GitHub 用户必须在目标仓库有当前 **admin** 权限。在该设备新建 `xallor.local.yaml`：

```yaml
owner: xallor-ai
repo: xallor
```

```sh
npm run channel -- agent repo apply xallor.local.yaml agent.local.yaml
```

**Docker 部署须在 bridge 所用卷内登记。** 上面是原生 bridge 的命令；容器使用命名卷里的 journal 和 inbox。将同一份非敏感仓库声明通过标准输入交给运行中的 agent 容器（保持已有项目和 compose 路径）：

```sh
docker compose -f ./agent-data/.channel-agent/compose.yaml exec -T agent node dist/cli.js agent repo apply - /app/agent.runtime.yaml < xallor.local.yaml
docker compose -f ./agent-data/.channel-agent/compose.yaml exec -T agent node dist/cli.js agent repo status - /app/agent.runtime.yaml < xallor.local.yaml
```

在 PowerShell 中可用 `Get-Content -Raw -Encoding utf8 xallor.local.yaml | docker compose ...` 代替输入重定向。容器与原生客户端不能共享一份本机收件进度。若之前只在宿主机 apply，应在容器内重做相同声明的幂等 apply，然后核对当前 bindingId 和 localActivityInbox；不需要重新配对或重建绑定。

例如设备配置为 `openclaw/github` 时，一次操作就会绑定并显示 `xallor-ai/xallor → openclaw/github`。省略 `declaration` 相当于启用，省略 `events` 表示跟随 Channel 支持的事件范围。服务端只会收到 App 已订阅、安装已获权且实际投递的活动。普通评论更新上下文；开放线程中直接提及 App 的评论、或创建 Issue 时明确提及 App，才会按默认策略委派。自己的评论记作回执，不会再次唤醒 Agent。推送不会单独启动评审。

在同一台已授权设备上更换负责 Agent：选用指向新 Agent 的本机配置并再次显式 `apply`。修改本地文件本身不改变远端绑定；领取任务或读取活动时身份须与绑定一致。当前不支持另一台设备接管已有绑定。

**读取状态。** `npm run channel -- agent repo status xallor.local.yaml agent.local.yaml` 仅读取。返回本地 `desired`、本机 Agent、服务器保存的 `binding`（含修订；未登记则为 null）和 `effective`。状态 `active` 表示远端绑定与本地要求匹配；`disabled` 表示确认已停用；`local_pending` / `disable_pending` 表示本地启用或停用要求尚未达成。

| 要核实什么 | 读哪些字段 |
| --- | --- |
| 谁负责，设备是否在线 | `effective.responsibleAgent` 是当前绑定，`localAgent` 是本机当前选择。`effective.runtimePoll` 显示服务器最近收到该设备和 Agent 的有效领取轮询时间（`lastPolledAt`，Unix 毫秒）。两分钟内为 `recent`，更早为 `last_seen`；无记录为 `never_seen`，无有效绑定为 `unbound`，证据不可用为 `unknown`。执行长任务时轮询可暂停，这些状态不证明模型可用或设备离线。 |
| 哪些事件可能收到 | `channelSupported` 是 Channel 支持的事件及动作，`channelEventFilter` 是此绑定选择。`eventCoverage` 逐项比较安装返回的订阅和读取权限；缺订阅或权限为 false，信息不全为 unknown。即使 eligible 为 true，也不证明 GitHub 已投递；实际收到的活动见下节。 |
| 超出范围的事件 | `subscribedFamiliesOutsideChannel` 是 App 订阅但 Channel 不支持的事件类别。已支持类别中，未列在 `channelSupported` 的动作也不会受理。 |
| 哪些自动执行 | 默认仅明确委派。`autoTriage`、`autoReview`、`triggerLabel` 显示仓库启用的附加规则；规则只作用于已选且收到的事件，执行仍检查发起人权限。 |
| 能否深评、发原生 Review 或提交代码 | `reviewCapabilities` 是绑定授权与适配器声明的交集；`missingCapabilities` 列出已选但缺少的能力。普通评论与原生 Review 是不同回执。`serverWriteProfile` 仅表示服务器是否配置了该仓库的写入策略；执行、路径、验证、GitHub 权限及目标版本仍需逐项核对。 |

**按需开启自动处理。** 以下是 OpenClaw 分析 Agent 的仓库配置示例。ACP 用于编码，绑定时会拒绝 `autoTriage: true` 或 `autoReview: true`；ACP 仍可接收明确提及或管理员配置的委派标签。只保留确实希望开启的规则。标签名精确匹配；不设标签也能观察 `issues.labeled`。深评及原生 Review 分别选择；详见 [PR 评审](pr-review.md)。

```yaml
declaration:
  enabled: true
  autoTriage: true
  autoReview: true
  triggerLabel: agent
  deepReview: true
  nativeReview: true
```

只有要缩窄观察面时才指定 `events`，例如 `events: [issue_comment.created, issues.opened]`；显式列表不会自动包含将来新增的事件。不使用 `events: all`。停用时保留仓库名，写入 `declaration: {enabled: false}` 并 `apply`。掉线、退出和删除文件都不会停用。修改规则或更换 Agent 将产生新修订，旧执行及发布由服务器按修订隔离。

**并发和失败。** `apply` 每次先读取服务器当前修订，再提交一次。仓库文件不接受 `expectedRevision`。读取之后若发生冲突，客户端重新读取已验证的当前绑定、显示 `current` 与 `desired`，不自动覆写；比较后由管理员决定下一次调整。网络中断、无法验证的响应会报告 `unconfirmed`；先 `status` 再决定。遇到 `installation_scope` 检查安装和选仓；`administrator_permission` 检查配对人的权限；`device_unauthorized` 检查设备凭据与撤销情况；`binding_owner` 检查设备归属与负责 Agent；`github_unavailable` 表示 GitHub 状态未核实。

## 读取已收到的活动

```sh
npm run channel -- agent repo activities xallor.local.yaml agent.local.yaml 0 25
```

最后两个参数分别为上次读取的游标（首次 0）及页大小（1–100，默认 25）。该命令不调用模型，也不领取执行任务。返回的每条活动包括投递 ID、来源、目标、接收时间、触发原因、短摘录及关联的任务 ID（未开工时为 null）。`taskId` 不代表任务成功；确认发布还要看任务及 GitHub 回执。

要明确委派，请在正文写 `@机器人 请分析这个问题`。普通列表、括号及强调中的提及也有效；代码、引用、链接、转义的用户名、删除线内的文字不触发。同一段删除线外仍可委派；含原始 HTML 时保守处理。若在评论内附带大量 Markdown 语法或 diff，请把 `@机器人 ` 放在第一行开头，整条不要超过 16,000 个 UTF-16 码元。

由获授权的调用方保存每个仓库绑定的 `nextCursor`，有 `hasMore` 时继续翻页；换修订后可从 0 开始。活动页只暴露当前启用的绑定修订，最多保留最近 7 天、每仓库 1024 条；`truncated` 表示有记录已越过保留边界。它不是完整审计档案，也不会自动重放过期模型任务。摘录自身被裁短时有独立的 `truncated`。`agent run` 会为本机已成功 `apply` 的绑定自动分批读取活动页并保存游标。`status` 中的 `localActivityInbox` 展示本机与当前绑定修订匹配的收件进度；没有匹配记录为 null，本机收件库无法读取为 unavailable。收到活动仅表示连接器读到了这批记录，不会为此额外调用模型，也不代表模型会话已收到通知。没有成功 `apply` 的本地文件、单独执行 `status` 或有冲突的配置不会新增本机订阅。活动接口每页均返回 `bindingId`，包括空页；绑定修订变化时不得沿用旧修订的回执。生产环境哪些组合有实际回执，见[能力台账](capabilities.md)。

后台轮询独立于任务领取与执行。每次读取一个仓库的一页（最多 25 条）；单次最多等待 15 秒。本机按修订保存最近 256 条活动（含来源、发起人和有界摘要）；先把事件与游标一起落盘，下一轮才逐条向服务端确认。用 `npm run channel -- agent repo inbox <声明文件> <agent配置文件> [after] [limit]` 查看本机实际收件和 ACK 状态；命令会在线复核当前绑定。`activities` 读的是云端活动，不是本机收件。`pollStatus` 为 `synced`、`not_yet_polled`、`denied` 或 `unconfirmed`；拒绝时不展示旧的进度计数。

后台收件与执行领取独立：首次可立即检查，此后每轮结束至少等 15 秒，轮转一个仓库、一页至多 25 条。没有游标进展的仓库至少等 60 秒；连续错误或拒绝按 60、120、240、480、900 秒退避，其他可读仓库不随之停收。它不是实时推送保证；不缓存成功授权来代替下一次校验。

**回答负责 Agent 的问题。** 在绑定 OpenClaw 的 Issue 或 PR 评论中委派分析后，如果 Agent 缺少必要信息，它可以在原线程提出澄清。只有经过 Channel 核实的 Bot 问题启用续办；普通回复中的问号不启用。问题发给原委派人，七天内有效。同一绑定、同一线程里只有一个属于你的待答问题时，直接发新评论即可，无需再次 `@`。有多个问题时，按 Bot 给的引用，以 `/answer <问题 ID> 答复内容` 开头。其他人不能代答。

每轮保留原请求和此前确认过的答复，最多连续四个问题；到达上限后应根据已有证据回答并指出缺项。PR 续办以新领取时核实的版本为准。这里的续办只支持只读分析，不会启动 ACP 编码或新建 PR。当问帖已可见、服务端仍在等 GitHub 回包时，能够唯一归属的答复先暂存；只有确认问帖及时间顺序后才会执行。若归属不明或两条评论的 GitHub 创建时间相同，请在之后的新评论中用问题引用作答。

若答复在下发给 Agent **之前**因权限不足被拒，或设备离线超过 24 小时导致未领取的答复过期，原评论仍保留这次未下发的记录。权限和连接恢复、问题仍在七天窗口内时，请发一条新评论回答；重投旧评论不会重跑。若任务已领取而执行结果不明，应先查原任务，不自动重试。续办期间 PR 已关闭或版本改变时，可保留已读取的事实，同时跳过公开回帖。
