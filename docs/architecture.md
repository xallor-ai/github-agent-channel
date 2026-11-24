# GitHub Agent Channel v2 架构

**`github-agent-channel` 包含服务端和内网连接器。** GitHub App（例如 `xallor-robot`）是它在 GitHub 上的身份；执行任务的是用户自己的 Agent。ECS 只是服务端的一种部署方式。

```mermaid
flowchart LR
  G["GitHub：App 安装、事件订阅与 API"]
  subgraph Channel["github-agent-channel"]
    S["服务端：受理、授权、队列与发布"]
    B["内网连接器：领取、调用与上报"]
  end
  R["用户的 Agent 运行环境"]
  G -->|签名 Webhook| S
  S -->|以 App 安装身份读取或发布| G
  B -->|主动 HTTPS 领取任务及上报结果| S
  B -.->|规划：登记或停用仓库绑定| S
  B -->|调用 OpenClaw 或通过 ACP 调用编码 Agent| R
  R -->|分析结果或实际变更| B
```

实线为当前链路；虚线是[仓库接入设计 #9](https://github.com/xallor-ai/github-agent-channel/issues/9)，尚未实现。任务随连接器的领取响应返回，内网 Agent 无需公网入站地址。

| 角色 | 职责与边界 |
| --- | --- |
| GitHub App / 安装 | 定义订阅的事件和所需权限，由安装者授予仓库范围。GitHub 投递 Webhook；安装本身不会替 Channel 建任务。 |
| Channel 服务端 | 持有 App 私钥，验证签名，按绑定和事件规则建任务；校验发起人权限，持久保存成果，并按策略向 GitHub 写回。 |
| 内网连接器 | 主动领取任务、记录本地执行状态、调用配置好的适配器并上报结果。规划中由它声明想接哪些仓库，由服务端核准并保存绑定；连接器不能自行授予仓库权限。 |
| Agent 运行环境 | OpenClaw 用于读取分析；已有编码 Agent 可经 ACP 在准备好的工作区修改文件。Agent 不持有 Channel 的 App 私钥，也不能改变任务的授权范围。 |

以 `xallor-ai/xallor` 为例：**当前**即使 App 已获该仓库授权，仍须在服务端静态 `bindings` 中启用仓库及相应规则，服务启动时加载。**目标**是在内网客户端启用仓库、选择触发规则，服务端核验安装范围和配置者权限后使绑定生效，无需改 ECS 配置。未绑定、已停用或规则不匹配时不建任务；有效绑定且规则匹配时入队，在线就领取，离线则有期限地等待。离线不等于停用。

## 当前实现调用链

```mermaid
flowchart LR
  GH[GitHub] -->|签名事件| C[Channel 接入与授权]
  C --> Q[(任务与 outcome)]
  B[出站 Bridge] -->|v2 claim / tool / result| C
  B --> J[(执行 journal)]
  B --> F[Runtime factory]
  F --> O[OpenClaw Responses]
  F --> A[官方 ACP SDK]
  A --> H[已有编码 harness 与准备好的工作区]
  Q --> P[受控 publication]
  P -->|评论或 draft PR| GH
```

## 核心职责

| 层              | 负责                                             | 不承担                     |
| --------------- | ------------------------------------------------ | -------------------------- |
| GitHub 接入     | 签名、source/target、事件与触发规则              | 模型执行                   |
| 任务控制        | scope、actor、assignment、lease、结果/回执持久化 | Runtime 内部推理与工具规划 |
| 出站 bridge     | 本地 journal、适配器选择、结构化结果确认         | GitHub 私钥与任意跨仓写入  |
| Runtime adapter | Provider 协议、生命周期标识与能力限制、产物整理  | 改写仓库/身份授权范围      |
| Publication     | 重新授权、路径/基线策略、评论/Git Data/PR API    | 执行仓库测试、自动 merge   |
| HTTPS edge      | TLS、域名、仅转发 v2 与 webhook 路径             | 长任务处理                 |

## 当前实现选择

GitHub 身份与 API 复用 Octokit；ACP 复用官方 SDK，调用管理员安装的 harness。工作区必须预先准备，Channel 不复制 OpenHands 一类的执行平台。窄范围复用依据见[实现设计](runtime-neutral-design.md)。

任务、outcome、publicationReceipt 分离，目标可为 Issue/PR/仓库；文本只是成果的一部分。任何 GitHub 写入前重新核对 actor 和 binding。PR 默认关闭，启用后固定 baseBranch 和允许文件范围，分支由 task ID 派生。

v2 直接删除旧字段、协议和数据库迁移路径；只接受新格式。云和本地分别持久化网络两端的责任。超时、断线、重启仍保守 unknown；ACP 的 cancel 请求不是已停止证明，不自动恢复或重跑。

## 尚存边界

- 单可信 worker/实例，串行执行；没有多租户、动态多 worker 路由或自动续租。
- OpenClaw 当前仍是读取/分析适配器；ACP 依赖已有 harness 的原生文件/终端工具，未提供客户端 filesystem/terminal 服务。
- ACP 原生进程不是 sandbox；工作区隔离由部署者提供，禁止共享工作区。Docker 自动渲染仅支持 OpenClaw bridge。
- PR 基线在发布前检查并固定 commit parent，但不能原子阻止 GitHub base 在随后推进；分支冲突和不确定写入不自动覆盖/重放。
- 本地协议/SDK 验收与真实环境分开记录；当前已验证 OpenCode 1.3.17 的 [Issue→代码→PR 闭环](acp-live-validation-20261124.md)，不代表所有 ACP harness 已互通。

文件职责、状态与证据分别见[实现地图](implementation-map.md)、[能力台账](capabilities.md)、[验证记录](runtime-neutral-validation-20261122.md)。
