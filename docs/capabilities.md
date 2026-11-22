# Channel 能力与验收台账

目标是让 GitHub 任务进入用户的 Agent 执行环境并产生可验证的工作成果。当前优先闭环为 **Issue → 修改代码 → 测试 → 创建 PR**。评论是交互与反馈方式之一，分析回帖成功不代表这个目标已经实现。

本表适用本次 v2 更正实现（2026-11-22）。配置、协议、状态库均不兼容旧版。代码路径在本地测试；真实环境列明确区分 v1 历史证据和 v2 尚未验收项目。

## 状态和证据口径

- **已实现**：代码存在，并列出测试或源码入口；不自动代表线上已验收。
- **部分实现**：只支持表中明确写出的子集。
- **未实现**：缺少执行路径，不能通过增加事件订阅或修改提示词使其生效。
- **受限/拒绝**：当前代码主动阻止该操作；这可能是待扩展边界，不一定是程序缺陷。
- **本次本地**：本轮重新执行；GitHub 和模型使用替身，HTTP、SDK 和 SQLite 按对应测试实际运行。
- **历史真实**：引用已有公网 GitHub/OpenClaw 验收记录；本轮没有重新执行该真实场景。
- **待验收**：尚无对应环境的成功证据。未来新增能力必须单独验收。

## 1. 任务入口与事件

| ID  | 能力                                 | 实现状态与限制                                                                | 证据                                                                         | 真实环境状态                 |
| --- | ------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| E01 | 接收签名 Webhook                     | 已实现；验签原始正文后解析                                                    | [webhook.ts](../src/webhook.ts)、[webhook.test.ts](../tests/webhook.test.ts) | v1 历史真实通过；v2 待验收   |
| E02 | Issue 评论 @App 发起任务             | 已实现；只接受 created、明确提及、匹配 binding 的人类评论                     | 同上；[outbound-e2e.test.ts](../tests/outbound-e2e.test.ts)                  | v1 历史真实通过；v2 待验收   |
| E03 | PR 会话区评论 @App                   | 部分实现；沿用 issue_comment，可读取标题/正文与回帖；不是代码审查             | [server.test.ts](../tests/server.test.ts)、[github.ts](../src/github.ts)     | PR 场景待验收                |
| E04 | Issue 创建/标签触发                  | 显式启用 issues.opened（需提及）、issues.labeled（指定标签）；assigned 未实现 | generic-tasks/webhook 测试                                                   | 本地通过；真实待             |
| E05 | PR 创建/更新触发                     | 显式启用 pull_request.opened/synchronize；其他 action 未实现                  | generic-tasks/webhook 测试                                                   | 本地通过；真实待             |
| E06 | PR review / 行内 review comment 触发 | 未实现；两个 review 事件被忽略                                                | 同上                                                                         | 待实现                       |
| E07 | push 触发                            | 显式启用有效非删除分支 push，产生 repository target                           | generic-tasks/webhook 测试                                                   | 本地通过；真实待             |
| E08 | check_run / check_suite 触发         | 未实现；被忽略                                                                | 同上                                                                         | 待实现                       |
| E09 | workflow_run / workflow_job 触发     | 未实现；被忽略                                                                | 同上                                                                         | 待实现                       |
| E10 | discussion / discussion_comment 触发 | 未实现；被忽略                                                                | 同上                                                                         | 待实现                       |
| E11 | release 触发                         | 未实现；被忽略                                                                | 同上                                                                         | 待实现                       |
| E12 | 防止机器人回复触发自身               | 已实现；忽略 Bot、自己的消息和不匹配的提及                                    | webhook.test.ts                                                              | 历史真实观察到回帖事件被忽略 |
| E13 | 重复投递只对应一个任务               | 已实现；delivery 和 scoped comment 去重                                       | [store.test.ts](../tests/store.test.ts)                                      | 历史真实重投通过             |

GitHub App 勾选事件仅表示平台会投递。未配置 binding.events 时默认只处理符合条件的 `issue_comment.created`；可显式启用已实现的 `issues.opened/labeled`、`pull_request.opened/synchronize` 和 `push`，并满足对应触发规则。未启用或未实现的事件会被忽略，通常返回 `200 {ignored:true}`；这个 HTTP 200 不代表任务执行成功。

## 2. 上下文、模型和执行环境

| ID  | 能力                               | 实现状态与限制                                                                                  | 证据                                                                                | 真实环境状态                            |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| R01 | 内网主动领取任务                   | 已实现；HTTPS claim/tool/result，不要求内网入站                                                 | [agent.ts](../src/agent.ts)、[pull.test.ts](../tests/pull.test.ts)                  | v1 历史真实通过；v2 待验收              |
| R02 | Runtime 调用                       | 已实现 OpenClaw 与官方 ACP SDK 适配器；type 必填                                                | [runtime-factory.ts](../src/runtime-factory.ts)、runtime-factory/acp-connector 测试 | OpenClaw v1 历史真实；ACP 模型待验收    |
| R03 | 多轮客户端工具调用                 | 已实现；限定工具、轮数、响应大小和执行期限                                                      | [connector.ts](../src/connector.ts)、connector.test.ts                              | v1 历史真实通过；v2 待验收              |
| R04 | 读取任务 Issue/PR                  | 部分实现；标题与正文，不含完整评论历史、diff 或审查历史                                         | [github.ts](../src/github.ts)、[github.test.ts](../tests/github.test.ts)            | Issue v1 历史真实通过；v2 待验收        |
| R05 | 读取单个仓库文件                   | 部分实现；默认分支、指定路径、文件至多 128 KiB                                                  | 同上                                                                                | v1 历史真实通过；v2 待验收              |
| R06 | 列目录、搜索代码、读取仓库树       | ACP 委托已安装 harness 的原生工具；核心未暴露此类 GitHub read API                               | [ACP 适配器](../src/acp-connector.ts)                                               | 真实 harness 待验收                     |
| R07 | 读取 PR diff、head/base 和检查日志 | 未实现；read_issue 不提供这些数据                                                               | github.ts；本次 read_diff 请求被拒绝                                                | 待实现                                  |
| R08 | 固定任务 base SHA                  | ACP 捕获工作区 HEAD；PR 发布校验远端 base HEAD；OpenClaw read_file 仍读默认分支                 | runtime-workspace/github-publication 测试                                           | 本地通过；真实待验收                    |
| R09 | 仓库与工作区                       | 部分实现；映射管理员准备的干净独立 clone，校验 origin；不自动 clone/重置/分配 sandbox           | [runtime-workspace.ts](../src/runtime-workspace.ts)                                 | 本地通过；不是多租户隔离                |
| R10 | 修改文件并收集 diff                | ACP 委托 harness 编辑，保留 BOM 收集实际 UTF-8 文件变更；拒绝改 HEAD、特殊模式/超限文件         | acp-connector.test.ts                                                               | 真实协议子进程 fixture 通过；模型待验收 |
| R11 | 执行项目验证                       | 运行管理员配置的验证命令，记录退出码/日志；失败、未知或验证前后候选文件变化均禁止发布           | acp-connector.test.ts                                                               | 真实本地验证进程通过；真实项目待验收    |
| R12 | 结构化成果                         | 已实现必需 outcome：text/artifacts/publication；产物与发布回执分别存储                          | [outcomes.ts](../src/outcomes.ts)、generic-outbound.test.ts                         | 本地 HTTP/SQLite 通过                   |
| R13 | 运行状态与恢复                     | 记录 Runtime session/run handle；ACP 可请求取消，但不保证后代停止；无自动 resume 或远端运行查询 | agent/acp-connector/generic-outbound 测试                                           | 部分实现；未知状态人工对账              |

## 3. GitHub 输出与协作成果

| ID  | 能力                          | 实现状态与限制                                                             | 证据                                                  | 真实环境状态                                           |
| --- | ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| O01 | 分析结果评论发布              | 已实现显式 comment publication；none 则保存成果并 skipped                  | worker/generic-outbound 测试                          | v1 历史真实；v2 待验收                                 |
| O02 | 评论去重和结果不明对账        | 已实现；按任务 marker 查询；不明确时进入 unknown，不盲目重发               | github.test.ts、worker.test.ts                        | 重投v1 历史真实通过；v2 待验收；网络故障场景为本地测试 |
| O03 | 创建任务分支                  | 已实现服务端派生 channel/task-id 分支，冲突拒绝                            | [github-publication.ts](../src/github-publication.ts) | 实际 SDK + 替身 API 通过；真实待                       |
| O04 | 提交文件变更                  | 已实现 Octokit blob/tree/commit/ref；只为显式 writePolicy 申请写权限       | github-publication.test.ts                            | 实际 SDK + 替身 API 通过；真实待                       |
| O05 | 创建关联 Issue 的 PR          | 已实现默认拒绝、基线/路径/权限校验后创建 draft PR；不自动合并              | github-publication/generic-outbound 测试              | 真实 GitHub 代码 PR 尚未验收                           |
| O06 | 记录代码和 PR 成果            | 已实现 change_set/test_report/outcome/publicationReceipt；无旧文本/URL别名 | store/generic-outbound 测试                           | 本地持久化/重启通过                                    |
| O07 | 发布代码 review / 行内建议    | 未实现；普通 PR 会话评论不能替代 review                                    | github.ts                                             | 待实现                                                 |
| O08 | 合并 PR、修改工作流、发布版本 | 未实现；不属于本次 Issue→PR 的默认授权                                     | github.ts、架构边界                                   | 不纳入本次闭环                                         |

## 4. 权限、持久性和部署

| ID  | 能力                             | 实现状态与限制                                                                              | 证据                                                                                         | 验收范围                           |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| S01 | 安装范围与发起人权限分离         | 已实现；仓库身份匹配，actor 需 write/maintain/admin                                         | github.test.ts、pull.test.ts                                                                 | 本次本地通过；真实授权评论历史通过 |
| S02 | 每次工具和外部回写重新授权       | 已实现；读取、评论及每次 Git Data/PR 写入前均重新授权                                       | github.test.ts、github-publication.test.ts、worker.test.ts                                   | 本次本地失权用例通过               |
| S03 | 模型不能覆盖目标仓库/Issue/身份  | 已实现；可信上下文来自已保存任务，工具参数严格检查                                          | webhook.test.ts、pull.test.ts                                                                | 本次本地通过                       |
| S04 | Webhook 持久化后 ACK             | 已实现                                                                                      | server.test.ts、store.test.ts                                                                | 本次本地通过                       |
| S05 | 云端 assignment、lease、结果幂等 | 已实现；单可信 worker，未知任务阻塞继续执行                                                 | [pull-store.test.ts](../tests/pull-store.test.ts)、pull.test.ts                              | 本次本地通过                       |
| S06 | 内网 journal、重启和重复结果处理 | 已实现；运行中断转 unknown，结果重传不重跑模型                                              | [agent-store.test.ts](../tests/agent-store.test.ts)、[agent.test.ts](../tests/agent.test.ts) | 本次本地通过                       |
| S07 | 写仓副作用与对账                 | 部分实现；publication 状态和 receipt 持久化，未知不重放；中间 blob/commit/branch 不自动恢复 | github-publication/worker 测试                                                               | 丢响应、失权、冲突本地通过         |
| S08 | 写路径、基线与分支策略           | 已实现固定 baseBranch、base SHA 校验、任务分支、路径/模式/数量/大小限制                     | github-publication.test.ts                                                                   | 本地通过；写权限需显式配置         |
| S09 | 多租户、多 worker 路由           | 未实现；实例共享的一个 connector 身份不构成租户隔离                                         | contracts.ts、pull-store.test.ts                                                             | 不纳入本次闭环                     |
| S10 | 部署与配置                       | OpenClaw 原生/Docker、external/Caddy；ACP 仅原生连接器；旧库拒绝无迁移                      | deploy/agent-deploy/schema 测试                                                              | Docker v2 隔离通过；线上仍旧部署   |

## 本次验证与限制

- 自动化结果见 [v2 验证记录](runtime-neutral-validation-20261122.md)。包括真实本地 HTTP/SQLite、官方 ACP SDK 子进程、实际 Git 文件变化、验证命令和 Octokit transport 测试。
- Docker external/Caddy 隔离测试已验证 v2 路由、签名、UID、持久性及出站结果；GitHub/模型行为为合成 fixture。
- 没有把真实生产服务切换到 v2，也没有以本地 fixture 宣称真实编码模型→GitHub PR 已验收。
- workspace 原生进程不是 sandbox；不支持自动恢复未知执行、并发多租户或全部 GitHub events。

当前接口与职责见 [实现地图](implementation-map.md)，使用方式见 [OpenClaw](setup.md) 和 [ACP](acp-setup.md)。每项能力独立维护源码、本地证据与真实验收，禁止用单一“完成”标志代替。
