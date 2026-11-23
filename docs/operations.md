# 主动连接运维与恢复

状态：当前运行契约；涵盖通用 v2 任务与发布；OpenClaw 和 ACP 各自能力、部署限制见适配器教程。通用 Channel 的其他能力状态见[能力台账](capabilities.md)。

首次接入从[完整配置主线](setup.md)开始；自建服务端看[可选ECS部署](ecs-setup.md)。本文用于部署后的诊断、升级、备份和未知任务对账。

## 两端职责和前置条件

Channel 服务端运行接入、任务、GitHub 授权与发布，HTTPS 由入口层处理；ECS 是可选的自建部署示例。内网运行本仓库出站连接器，按 type 选择 OpenClaw 或 ACP。所有跨网请求由连接器发往服务端，服务端不调用内网地址。需要 Node24，容器命令要求 Compose插件2.20+。旧独立 `docker-compose` 不受支持。

GitHub App 启用 Issue comment，权限 Metadata/Contents Read、Issues/Pull requests Write。绑定的仓库 ID、installation ID 和 owner/repo 由服务端固定。每次领取、工具请求和回帖前重新核验调用者仓库权限。

## 配置迁移与凭据

之前的云端 `runtime` 配置已移除。云端现在使用 `connector.workerId/tokenFile或tokenEnv/timeoutMs`。旧版直连配置将校验失败，不能静默沿用。v1 任务协议和旧数据库也被拒绝，没有自动迁移。新部署前按[v2 契约](protocol-v2.md)准备新状态库。

内网的 `agent.local.yaml` 配置 `channel`（ECS URL 与连接器token）、`runtime`（显式 type 和对应配置）、`stateFile`、轮询/请求时间。OpenClaw Responses必须启用；单次Runtime超时应短于云端领取期限，给工具请求/结果回传留余量。

每项secret只允许Env/File之一。File相对配置文件目录解析；PEM保留换行，token去首尾空白。Linux容器UID1000，secret文件建议0600 owner1000或0640 group1000，父目录受限。云端管理token不能与connector token复用。Agent数据库含任务和未确认结果，需受保护且持久化。

配置初始化不生成或上传GitHub私钥，也不修改GitHub App。用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 在受控本机生成各类独立token，再保存文件；不要提交或贴入聊天。

云端校验：`npm run channel -- config check <cloud.yaml>`。Agent校验：`npm run channel -- agent check <agent.yaml>`。`doctor`只查离线配置与Compose版本；没有enabled binding会提示。

## 入口

已有Nginx用external，将生成片段加入现有HTTPS server；容器网关须与Channel加入共同 `deployment.network`，不能从网关容器用127.0.0.1访问宿主回环端口。片段使用Docker DNS动态解析，支持Channel重建换IP。

公网允许POST `/webhooks/github`（GitHub HMAC签名）和 `/connector/v2/`（独立Bearer，任务操作再验证lease）。管理 `/tasks/*` 与 `/healthz` 只通过宿主回环/受控私网访问。Caddy采用相同策略。

只修改Nginx镜像的templates文件再reload不会重新执行envsubst；需先在隔离配置中展开和 `nginx -t`，再受控发布并reload。不要覆盖其他站点。

## 原生与容器

原生云服务：设置 `CHANNEL_CONFIG` 指向云端YAML，`npm run build && npm start`。host建议127.0.0.1，dataFile为可写持久路径；相对dataFile按进程工作目录解析。

runtime.type 必须显式指定。ACP 使用[原生适配器配置](acp-setup.md)，不依赖 Gateway token，也不支持自动 Docker 渲染。

原生内网：`npm run channel -- agent run <agent.yaml>`。连接器只出站，不启动HTTP监听。重定向不会转发认证token；认证失败会提示，网络失败按有界退避重试。

生成容器配置会将云服务固定到0.0.0.0:3000及 `/data/channel.db`，Agent固定使用 `/data/agent.db`。它们分别有独立状态卷。Agent生成服务没有ports。Env引用以Compose secret来源使用，不会写成容器environment中的秘密值。

## v2 内部升级与回滚

以下复用卷步骤仅适用于 schema v2→v2；v1→v2 不支持迁移，必须使用新数据路径/卷并保留旧数据。

生成目录不可覆盖不同内容。配置变更渲染到新目录，并保留源码提交。保持同一 `deployment.projectName` 才能复用原卷；不同项目名可能误建空数据库。

1. 等待运行任务结束；先停止Agent，再停止Cloud（down不带-v）。
2. 备份SQLite及存在的WAL/SHM文件、secret引用和生成配置。
3. 生成新bundle，用相同projectName启动Cloud，再启动Agent。
4. 检查两端日志/状态、私网health、授权评论回帖。

同名bundle是原位替换，不能启动新bundle后再对旧bundle执行down。回滚需停止当前服务、恢复对应旧源码和配置；数据库schema不兼容时恢复备份。不要用down-v删除卷。不要删除Agent journal来重试任务。

## 租约和未知状态

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

若决定关闭未成功投递，用 `{"confirmedReconciled":true,"resolution":"failed"}`。PR 发布对账使用同仓库的 /pull/N URL；comment 使用当前 target 对应的评论 URL。这些操作不重跑、不重发。新的执行须来自已启用规则下的新事件。

## 边界

当前支持一个云实例的一个连接器身份（其任务受enabled bindings限制），不宣称多租户隔离或多worker路由。Agent journal的SQLite排他锁防止多个进程共享状态并执行；崩溃由OS释放锁。不能在不支持可靠文件锁的共享文件系统上运行。

隔离冒烟不调用真实GitHub或生产模型；公网ACME、真实GitHub事件和真实OpenClaw回帖需单独记录。旧直接调用架构和相关验证仅作为历史资料，不是当前部署说明。

## 预构建镜像

用一次性容器生成部署 bundle 时，生成用户应与后续执行 Compose 的部署账号一致，并确保它能读到引用的 secret。否则生成器创建的700目录可能属于root，普通账号运行 Compose 时会报 `.env: permission denied`。确需由root生成时，只修正该次输出目录和配置的归属，不放宽所有 secret 权限；本次实际遇到并解决的情况见[真实评审闭环](channel-review-validation-20261123.md)。

两端配置可选 `deployment.image: registry.example.com/team/github-agent-channel:<commit>`，生成器只使用image而不要求目标主机build context。未设置时仍从当前源码目录构建。镜像需包含编译后的dist和生产依赖（仓库Dockerfile）。

目标机没有Node时，可用同一镜像运行配置生成CLI。将配置目录及输出目录按相同绝对路径挂载到一次性容器，执行 `node dist/cli.js deploy render <cloud-config> <bundle>`（Agent用 `agent deploy render`），然后在宿主执行 `docker compose -f <bundle>/compose.yaml up -d --wait`。secret文件仍由宿主Docker按生成引用挂载，不复制到镜像。生成容器与长期服务的UID应正确配置；应用服务保持UID1000。
