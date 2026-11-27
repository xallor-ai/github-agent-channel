# 主动连接运维与恢复

状态：当前运行契约；涵盖通用 v2 任务与发布；OpenClaw 和 ACP 各自能力、部署限制见适配器教程。通用 Channel 的其他能力状态见[能力台账](capabilities.md)。

首次接入从[完整配置主线](setup.md)开始；自建服务端看[可选ECS部署](ecs-setup.md)。本文用于部署后的诊断、升级、备份和未知任务对账。

PR 任务只接受 open 快照，领取及发布评论前会重新向 GitHub 查询。已关闭、已合并或查询失败时，不发起评论写入。最后一次查询和创建评论是两个请求：如果恰在两者之间合并，GitHub 仍可能接收评论。遇到迟到回帖，按任务标记和发布回执核对实际结果，不在旧 PR 重发或追加解释；后续工作从最新基线另行委派。

## 两端职责和前置条件

Channel 服务端运行接入、任务、GitHub 授权与发布，HTTPS 由入口层处理；ECS 是可选的自建部署示例。内网运行本仓库出站连接器，按 type 选择 OpenClaw 或 ACP。所有跨网请求由连接器发往服务端，服务端不调用内网地址。需要 Node24，容器命令要求 Compose插件2.20+。旧独立 `docker-compose` 不受支持。

GitHub App 启用 Issue comment，权限 Metadata/Contents Read、Issues/Pull requests Write。绑定的仓库 ID、installation ID 和 owner/repo 由服务端固定。每次领取、工具请求和回帖前重新核验调用者仓库权限。

## 配置迁移与凭据

之前的云端 `runtime` 配置已移除。云端 connector 只需 timeoutMs；仓库规则通过[设备配对与登记](agent-self-service.md)管理。旧静态 bindings 和共享凭据不是后备入口。旧版直连配置将校验失败，不能静默沿用。v1 任务协议和旧数据库也被拒绝，没有自动迁移。新部署前按[v2 契约](protocol-v2.md)准备新状态库。

内网的 `agent.local.yaml` 配置 `channel`（ECS URL 与配对时生成的设备令牌）、`runtime`（显式 type 和对应配置）、`stateFile`、轮询/请求时间。OpenClaw Responses必须启用；单次Runtime超时应短于云端领取期限，给工具请求/结果回传留余量。

每项secret只允许Env/File之一。File相对配置文件目录解析；PEM保留换行，token去首尾空白。Linux容器UID1000，secret文件建议0600 owner1000或0640 group1000，父目录受限。云端管理token不能与connector token复用。Agent数据库含任务和未确认结果，需受保护且持久化。

服务端凭据按[ECS 部署](ecs-setup.md)写入受限文件；设备令牌由配对命令生成。不要提交秘密文件或贴入聊天。

云端校验：`npm run channel -- config check <cloud.yaml>`。Agent校验：`npm run channel -- agent check <agent.yaml>`。`doctor`只查离线配置与Compose版本，不查询在线绑定；用 agent repo status 查看。

## 入口

已有Nginx用external，将生成片段加入现有HTTPS server；容器网关须与Channel加入共同 `deployment.network`，不能从网关容器用127.0.0.1访问宿主回环端口。片段使用Docker DNS动态解析，支持Channel重建换IP。

公网允许POST `/webhooks/github`（GitHub HMAC签名）和 `/connector/v2/`（独立Bearer，任务操作再验证lease）。管理 `/admin/*`、`/tasks/*` 与 `/healthz` 只通过宿主回环/受控私网访问。Caddy采用相同策略。

只修改Nginx镜像的templates文件再reload不会重新执行envsubst；需先在隔离配置中展开和 `nginx -t`，再受控发布并reload。不要覆盖其他站点。

## 原生与容器

原生云服务：设置 `CHANNEL_CONFIG` 指向云端YAML，`npm run build && npm start`。host建议127.0.0.1，dataFile为可写持久路径；相对dataFile按进程工作目录解析。

runtime.type 必须显式指定。ACP 使用[原生适配器配置](acp-setup.md)，不依赖 Gateway token，也不支持自动 Docker 渲染。

原生内网：`npm run channel -- agent run <agent.yaml>`。连接器只出站，不启动HTTP监听。重定向不会转发认证token；认证失败会提示，网络失败按有界退避重试。

生成容器配置会将云服务固定到0.0.0.0:3000及 `/data/channel.db`，Agent固定使用 `/data/agent.db`。它们分别有独立状态卷。Agent生成服务没有ports。Env引用以Compose secret来源使用，不会写成容器environment中的秘密值。

## v2 内部升级与回滚

以下复用卷步骤仅适用于相同 schema 的版本（云端任务库 8、连接器执行 journal 3、活动收件箱 2）。不兼容的旧库须保留，改用新路径/卷。

生成目录不可覆盖不同内容。配置变更渲染到新目录，并保留源码提交。保持同一 `deployment.projectName` 才能复用原卷；不同项目名可能误建空数据库。

1. 等待运行任务结束；先停止Agent，再停止Cloud（down不带-v）。
2. 在服务停止后一起备份任务库、独立设备身份库（`<dataFile>.devices`）、云端工具审计库（`<dataFile>.tool-audit.sqlite`）、连接器执行 journal（`<stateFile>`）、本机活动收件箱（`<stateFile>.inbox`）及各库存在的 SQLite journal/WAL/SHM 文件、secret 引用和生成配置。遗漏收件箱会丢失本机订阅、已存摘要和待确认清单。
3. 生成新bundle，用相同projectName启动Cloud，再启动Agent。
4. 检查两端日志/状态、私网health、授权评论回帖。

同名bundle是原位替换，不能启动新bundle后再对旧bundle执行down。回滚需停止当前服务、恢复对应旧源码和配置；数据库schema不兼容时恢复备份。不要用down-v删除卷。不要删除Agent journal来重试任务。

## 租约和未知状态

云端工具审计库使用独立的 v2 格式，与 v8 任务库分开。请为云端服务账户授予该目录读写权限，并限制其他账户访问；恢复时和对应的任务库一同恢复。首次启动若无审计库会创建空库，没有升级前的调用历史；若已存在但格式不符则拒绝启动并保留原文件。每个任务的每种云端工具只占一行，保留请求、成功和失败的次数及首次/最近请求、最近成功/失败的 UTC 毫秒时间。请求多于两种结果之和表示结果未确认。拒绝无效参数或初始租约时不创建工具记录。每行的 `lastFailure` 保存最近一次已接纳调用的失败分类；没有失败时为 null，后续成功不覆盖。不记录异常文本。

分类包括：`scope`（任务范围或授权未确认）、`lease`（读取期间租约失效）、`github_permission_or_resource`（GitHub 返回 401、403 或 404，无法确定是权限、资源还是平台限制）、`invalid_evidence`（上游 JSON 或数据结构无效）、`upstream_unavailable`（上游返回 408、429 或 5xx）、`unknown`（没有足够信息分类）。这些分类不是根因判断。部署时可设置 `CHANNEL_BUILD_SHA` 为完整的 40 位提交 SHA；该行的 `buildSha` 对应最近一次请求的云服务部署声明，未配置或无效时为 null。审计不保存工具参数、返回内容或异常正文，不计入桥接器本地调用，也不改变 Runtime 自报的运行记录。

领取时云端先持久化assignment，之后才返回任务。投递响应丢失不会重新投递同一执行。Agent在调用模型前写journal；进程重启看到执行中记录只报告unknown，不再次调用模型。结果回传失败只重试已持久化的同一结果；云端原子保存结果与幂等摘要后确认，重复同结果不会重复回帖，冲突409。

云端重启或租约过期会将执行标记unknown；unknown同时阻塞该binding及连接器，直到人工确认旧执行停止。即使断线后收到晚到成功结果，也不自动覆盖unknown。

在受控私网查询 `GET /tasks/<id>`（Bearer admin token）。确认模型执行已停止后，向 `POST /tasks/<id>/resolve` 发送：

```json
{ "confirmedStopped": true, "resolution": "failed" }
```

发布状态 unknown 时，先在GitHub核对配置bot发布且带 `<!-- github-agent-channel:<task-id> -->` 的评论，再向 `POST /tasks/<id>/resolve-delivery` 提交：

```json
{
  "confirmedReconciled": true,
  "resolution": "sent",
  "url": "https://github.com/OWNER/REPO/issues/123#issuecomment-456"
}
```

原生 Review 对账使用同一 PR 的 `https://github.com/OWNER/REPO/pull/123#pullrequestreview-456`。对照任务的 head SHA：服务端读取该 Review，核验 ID/URL、提交、配置的 bot、COMMENTED 状态、正文和任务标记；成功才记录 review 回执。即使 PR 已关闭、原绑定停用或原发起人失权，管理员仍可只读对账。服务端用受限于原安装及仓库 ID 的只读凭据核对仓库身份和 Review；安装已卸载或无法读回时，不能确认成功。不能核实时保留 unknown；不要重发以获取第二个回执。

若决定关闭未成功投递，用 `{"confirmedReconciled":true,"resolution":"failed"}`。PR 发布对账使用同仓库的 /pull/N URL；comment 使用当前 target 对应的评论 URL。这些操作不重跑、不重发。新的执行须来自已启用规则下的新事件。

## 边界

同一服务可登记多个设备。各设备只能领取当前归属自己的有效修订下的任务；不要在设备间复制令牌或 journal。Agent journal的SQLite排他锁防止多个进程共享状态并执行；崩溃由OS释放锁。不能在不支持可靠文件锁的共享文件系统上运行。

隔离冒烟不调用真实GitHub或生产模型；公网ACME、真实GitHub事件和真实OpenClaw回帖需单独记录。旧直接调用架构和相关验证仅作为历史资料，不是当前部署说明。

## 负责人收件与原评论对账

澄清评论发出但回包不明时，不要重跑模型或新发问题。用管理员 `POST /tasks/<id>/reconcile-clarification` 核验真实问帖；仅提供普通 GitHub URL 不能将问题确认成已发布。与一次在途提问关联的候选答复可暂存等待对账；未匹配的普通评论不会回放。只有证实 GitHub 问帖早于答复、归属明确、授权仍有效、窗口未过，才创建一次续办执行。普通留言发生时若有两个可能的问题，不会因为其中一个后来被回答就自动选另一个。使用 `GET /tasks/<id>/conversation` 分开查看每轮执行与公开回执，`answered` 表示已关联答复，不代表最终工作完成。

每套服务及其任务库只对应一个 GitHub App；更换 App 时新建库，不沿用其他身份的回执。升级本版本需保留旧云任务库和旧本机 `.inbox`，选用全新状态文件或卷，再用授权身份重新登记。不要重新投递旧事件来制造收件历史。本机收件箱含最多 1,024 字符的原评论摘要及登录名，备份须限制读权限。

管理员查 `GET /activities/<deliveryId>` 的 `ownerReceipt`；未确认时为 null。已确认的记录给出接收者、时间及该事件的独立 reaction 状态。若外部写入返回不明，使用 `POST /tasks/<taskId>/reconcile-reaction`：它只读取 GitHub 原评论上该 Bot 的 eyes，查到唯一匹配才补记 ID；找不到、无权或目标不符均不自动再写。不得重跑模型或改发评论代替。最终回复仍看任务的 `publicationReceipt`。

同一原评论重复投递时，`requestedDeliveryId` 是所查投递，`ownerReceipt.deliveryId` 是接收端实际确认的原始事件，两者可能不同。只有原评论 ID 时使用 `GET /repositories/<repositoryId>/comments/<commentId>/receipts`，普通讨论没有执行任务也能查。GitHub 限流只暂停相应安装后续未发的收件表情；当前失败条目不自动重投。执行排队过期与负责人收到评论是两件事；关闭、改绑或失权仍拦截新写入。

若原写入结果未知，而只读对账又遭 GitHub 限流，回执保留 `unknown / lookup_rate_limited`。在同安装的冷却期限内，后续待发项不出队，管理员重查返回 429，不访问 GitHub。到期后可以再查，仍不会重新发送原写入。

## 预构建镜像

用一次性容器生成部署 bundle 时，生成用户应与后续执行 Compose 的部署账号一致，并确保它能读到引用的 secret。否则生成器创建的700目录可能属于root，普通账号运行 Compose 时会报 `.env: permission denied`。确需由root生成时，只修正该次输出目录和配置的归属，不放宽所有 secret 权限；本次实际遇到并解决的情况见[真实评审闭环](channel-review-validation-20261123.md)。

两端配置可选 `deployment.image: registry.example.com/team/github-agent-channel:<commit>`，生成器只使用image而不要求目标主机build context。未设置时仍从当前源码目录构建。镜像需包含编译后的dist和生产依赖（仓库Dockerfile）。

目标机没有Node时，可用同一镜像运行配置生成CLI。将配置目录及输出目录按相同绝对路径挂载到一次性容器，执行 `node dist/cli.js deploy render <cloud-config> <bundle>`（Agent用 `agent deploy render`），然后在宿主执行 `docker compose -f <bundle>/compose.yaml up -d --wait`。secret文件仍由宿主Docker按生成引用挂载，不复制到镜像。生成容器与长期服务的UID应正确配置；应用服务保持UID1000。

### 工具读取和失败回执

`read_file` 读取默认分支上的单个文件。已授权的 Contents 请求遇到目录、404 或超过 128 KiB 时，模型分别收到 `not_a_file`、`file_unavailable` 或 `file_too_large`；没有文件内容，不能据此声称已核验 PR head。授权、限流、网络及上游服务错误仍中止读取。

连接器只上报固定失败原因码，不保存异常消息。确认模型没有给出可用结果（轮次耗尽、没有最终回答、工具调用或结果格式无效）时，Channel 可在仍开放、仍授权的原 Issue/PR 发布一条状态通知。通知有自己的发布回执，任务保持 failed，不产生分析成果。未知执行、授权失败和旧失败任务不自动重跑或补发。

原生 Review 的 POST 回包丢失且没有 ID 时，管理员先 GET `/tasks/<id>/lookup-review`，只读查验原 PR 上唯一的 Bot、任务标记、正文、commit 与链接。无匹配、多匹配、无法读取或超出扫描上限均保持 unknown，不证明写入失败。查得唯一链接后才按原流程提交 resolve-delivery；不重跑模型或 POST Review。

**草稿 PR 部分发布。** 如分支已创建但草稿 PR 未确认，delivery 保持 unknown。按诊断中的任务分支、commit SHA，在原仓逐一核对远端 ref 和关联 PR；branch confirmed 仅表示 ref 写入获得确认，branch unconfirmed 表示该写入也需核验。若崩溃发生在记录诊断前，检查固定的 channel/<task-id>。不要自动删分支或重试 POST；找到真实 PR 时按原管理流程记录 URL。仅有分支不能冒充 PR 回执。
