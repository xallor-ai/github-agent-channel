# 运行与恢复

本文对应当前单进程版本。首版读取目标 Issue/PR 的标题和正文、同仓默认分支的单个文件，并发布最终分析评论。它不会读取完整 PR diff 或评论历史给模型，也没有 Git 写仓工具。

## GitHub App

创建并安装 GitHub App 到目标组织或账号，优先选择明确的仓库列表。配置以下 Repository permissions：

| 权限 | 级别 | 当前用途 |
| --- | --- | --- |
| Metadata | Read | 仓库身份、调用者权限核验 |
| Contents | Read | 读取同仓文件 |
| Issues | Read and write | 读取 Issue、发布最终评论 |
| Pull requests | Read and write | PR 会话区普通评论 |

订阅 **Issue comment** 事件；Webhook URL 使用 `https://<your-domain>/webhooks/github`，启用 Webhook 并设置随机 secret。GitHub 发出的 `ping` 会被忽略；能收到 ping 不代表分析闭环已经可用。

记录 App ID、installation ID、repository ID、owner、repo 和实际 bot login（通常以 `[bot]` 结尾），填入配置。安装范围和本地 binding 必须同时匹配。仓库改名、转移或 App 重新安装后，应先更新配置并重启服务；旧任务的上下文不会被自动迁移。

下载 App private key，保存在仓库外受限位置。Channel 创建 token 时进一步限定单个 repository ID 及上述权限。App 安装不表示任意评论者都可启动任务：当前必须由人类 User 在新评论中明确提及 bot，且经 API 核验拥有 `admin`、`maintain` 或 `write` 权限。评论作者 ID、login 与 sender 必须一致，运行时还会核对 API 返回的用户 ID，避免同名账号继承授权。

## 配置与凭据

从 [channel.example.yaml](../deploy/channel.example.yaml) 复制本地配置，保留 `*Env` 引用。启动进程必须实际拥有这四类变量：

| 配置字段 | 对应环境变量的内容 |
| --- | --- |
| `github.privateKeyEnv` | 完整 PEM private key，包含真实换行 |
| `github.webhookSecretEnv` | 与 GitHub App Webhook 一致的 secret |
| `runtime.tokenEnv` | OpenClaw Gateway token |
| `server.adminTokenEnv` | 管理接口专用随机 token |

不要将变量的值放进 YAML、命令回执、Issue 或 Git。服务不会自动加载 `.env` 文件；本地运行由启动环境注入，Compose 按部署文件指定的方式注入。变量缺失、未知配置字段或重复 binding 会使启动失败。`CHANNEL_CONFIG` 默认是当前目录下的 `config.local.yaml`。

`runtime.baseUrl` 指向私网 OpenClaw Gateway；Connector 请求其 `/v1/responses`，使用 `openclaw/<agentId>`。Gateway 必须允许该 Responses 接口，且模型配置可用。为此 Channel 使用独立 Gateway、容器网络和 token，并单独配置受限 agent：不要赋予额外 GitHub 凭据、任意 Shell 或与此任务无关的高权限工具。Channel 的两个 function tools 并不能撤销 Runtime 自身另有的工具权限。

ConfigManager 提供校验和原子文件更新，但当前入口启动时只读取一次快照；没有公开配置更新 API，也没有已验证的全模块热更新。修改配置后按受控停启流程重启。

## 部署入口与网络

本地入口见 [README](../README.md)。容器定义见 [compose.yaml](../deploy/compose.yaml)，默认只启动不映射宿主端口的 OpenClaw。Channel 尚需真实 GitHub App 配置，因此通过 profile 显式启用。

Compose 从仓库根目录的 `.env` 向 Channel 注入环境，从 `config.local.yaml` 只读挂载 Channel 配置；OpenClaw 状态目录是 `deploy/state/openclaw`。先依据 [openclaw.example.json](../deploy/openclaw.example.json) 准备该目录中的 `openclaw.json`、私网 Gateway、Responses 接口及受限 agent 配置，并补全实际模型凭据。Channel 的 `env_file` 不会自动向 OpenClaw 传递凭据，两边应分别配置。本轮已验证 2026.11.3 的配置结构和 npm 容器部署；官方镜像模板尚未成功拉取验证，具体证据见 [远端验证](deployment-validation.md)。准备完成后启动两项服务：

```sh
docker compose -f deploy/compose.yaml --profile channel up -d --build
```

模板将 Channel 宿主端口限制为 `127.0.0.1:18896`。服务端监听地址与宿主端口映射是两层设置：容器内可监听 `0.0.0.0`，宿主只绑定回环或私网，再由 HTTPS 反向代理单独公开 `POST /webhooks/github`。不要将 `/tasks/*` 暴露公网。当前管理与 webhook 共用 HTTP listener，路径隔离需由代理、防火墙或私网边界实施；管理 Bearer token 不能替代这层隔离。

`dataFile` 所在目录需要可写且持久化。使用一个 Channel 实例，保留 SQLite 数据库及其 WAL 相关文件；备份优先停服后复制一致的数据库文件集合，恢复前保留原始备份。当前没有多实例部署验收。

健康接口 `/healthz` 只检查进程存活。真实验收应另确认 App 安装、有效签名事件落盘、真实模型工具续调用、GitHub 回帖，以及运行中失权时拒绝读取/发布。本文和部署模板都不表示这些远端检查已完成。

## 查询任务

在私网或回环访问 `GET /tasks/<task-id>`，请求头为 `Authorization: Bearer <admin-token>`。Webhook 接受成功会返回 task ID；管理查询返回执行状态、回帖状态、错误类别及已确认评论链接，不返回 prompt、模型结果或密钥。

| 状态 | 含义与处理 |
| --- | --- |
| `queued` | 已持久化，等待 worker；同 binding 的未决任务可能阻塞它 |
| `running` | 本地已开始处理，不等于 Runtime 已完成 |
| `succeeded` + `pending` | 分析结果已持久化，等待回帖 |
| `succeeded` + `sent` | 回帖已确认，评论链接可查 |
| `failed` / `rejected` | 已终止；后者表示授权被拒绝 |
| 执行或回帖 `unknown` | 外部结果不明，保持 binding 阻塞，先核对再解除 |

## 处理 unknown

进程启动会把遗留的 `running` 改为执行 `unknown`，把 `sending` 改为回帖 `unknown`；未开始的 `queued` 和已持久化待投递结果保留。网络超时、连接中断、部分服务端错误也可能产生 `unknown`。不要通过删除数据库、重投 Webhook 或反复重启来消除它。

**执行 unknown：** 在 OpenClaw 侧核对任务是否还在运行，并确认它已经停止。当前没有自动查询、取消或 resume API；多轮工具调用中间的 `previous_response_id` 只在内存保存，最终成功时才可能保存 response ID，不能据此恢复中断中的模型执行。确认远端已停止后，调用 `POST /tasks/<task-id>/resolve`：

```json
{"confirmedStopped":true,"resolution":"failed"}
```

该操作只将本地未知任务收束为失败，不会取消远端任务，也不会重跑。需要再次分析时，在确认旧任务不会继续执行后，新建一条明确 mention 评论。

**回帖 unknown：** 检查目标 Issue/PR 中配置 bot 发布的评论，并核对原始正文中的 `<!-- github-agent-channel:<task-id> -->`。不能只看相似文字，也不能把其他作者伪造的 marker 当成成功证据。确认已发布后，调用 `POST /tasks/<task-id>/resolve-delivery`：

```json
{"confirmedReconciled":true,"resolution":"sent","url":"https://github.com/OWNER/REPO/issues/123#issuecomment-456"}
```

这里 URL 必须对应当前仓库和目标编号，支持 `/issues/<number>` 与 `/pull/<number>` 两种评论路径。服务仅校验输入格式和目标，不替管理员向 GitHub 验证该评论，因此必须先人工核对。

确认此次回帖未成功且决定关闭投递后，可提交：

```json
{"confirmedReconciled":true,"resolution":"failed"}
```

这两种处理都不创建评论、不触发重发。正常发布前最多检查 10 页、每页 100 条评论；扫描到边界仍未找到 marker 时进入未知状态，交由人工核对，不越过边界盲目创建。此机制用于减少重复，不能保证外部评论恰好写入一次。

## 真实 OpenClaw 单独验收

设置 `OPENCLAW_GATEWAY_TOKEN`、`OPENCLAW_BASE_URL`（默认回环 18789）和可选的 `OPENCLAW_AGENT_ID`（默认 github），然后运行：

```sh
npm run smoke:openclaw
```

这会实际调用模型，可能产生 Provider 费用。脚本验证指定文本响应，以及 `read_issue`、`read_file` 的 client function calls 和 `previous_response_id` 多轮续调用。工具返回合成 Issue，不访问 GitHub；两个检查通过也不能证明真实 GitHub App 路径可用。

OpenClaw 配置使用 `agents.entries.github`，不再使用旧版 `agents.list/default`。模板禁用内置工具、Skills、浏览器、后台自动任务和 memory 插件；设置 `tools.toolSearch: false` 直接提供这两个工具的定义，只读工具由 Channel 在 Responses 请求中传入。不要为了让一个 client tool 可用而开放 Runtime 的全部工具。

在已运行的 Gateway 上校验配置，应使用该容器内的 `docker exec ... openclaw config validate`，不要启动另一个容器共享同一状态目录；2026.11.3 的状态所有权检查会拒绝不同 PID namespace 的并发访问。

参考：[OpenResponses 接口](https://docs.openclaw.ai/gateway/openresponses-http-api)、[agents.entries 配置](https://docs.openclaw.ai/gateway/config-agents/entries-and-multi-agent)。
