# Channel 能力与验收台账

目标是让 GitHub 任务进入用户的 Agent 执行环境并产生可验证的工作成果。当前优先闭环为 **Issue → 修改代码 → 测试 → 创建 PR**。评论是交互与反馈方式之一，分析回帖成功不代表这个目标已经实现。

本表核对日期：2026-11-22。核对代码基线：`4a0540c`，分支 `codex/outbound-connector`。本次只做能力审计和测试，没有新增写仓能力、修改线上配置或创建测试 PR。

## 状态和证据口径

- **已实现**：代码存在，并列出测试或源码入口；不自动代表线上已验收。
- **部分实现**：只支持表中明确写出的子集。
- **未实现**：缺少执行路径，不能通过增加事件订阅或修改提示词使其生效。
- **受限/拒绝**：当前代码主动阻止该操作；这可能是待扩展边界，不一定是程序缺陷。
- **本次本地**：本轮重新执行；GitHub 和模型使用替身，HTTP、SDK 和 SQLite 按对应测试实际运行。
- **历史真实**：引用已有公网 GitHub/OpenClaw 验收记录；本轮没有重新执行该真实场景。
- **待验收**：尚无对应环境的成功证据。未来新增能力必须单独验收。

## 1. 任务入口与事件

| ID  | 能力                                 | 实现状态与限制                                                    | 证据                                                                         | 真实环境状态                 |
| --- | ------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| E01 | 接收签名 Webhook                     | 已实现；验签原始正文后解析                                        | [webhook.ts](../src/webhook.ts)、[webhook.test.ts](../tests/webhook.test.ts) | 历史真实通过                 |
| E02 | Issue 评论 @App 发起任务             | 已实现；只接受 created、明确提及、匹配 binding 的人类评论         | 同上；[outbound-e2e.test.ts](../tests/outbound-e2e.test.ts)                  | 历史真实通过                 |
| E03 | PR 会话区评论 @App                   | 部分实现；沿用 issue_comment，可读取标题/正文与回帖；不是代码审查 | [server.test.ts](../tests/server.test.ts)、[github.ts](../src/github.ts)     | PR 场景待验收                |
| E04 | 新建、分配或标记 Issue 触发          | 未实现；issues 事件被忽略                                         | 本次签名事件探针；webhook.ts                                                 | 待实现                       |
| E05 | PR 创建、更新、重新打开触发          | 未实现；pull_request 事件被忽略                                   | 同上                                                                         | 待实现                       |
| E06 | PR review / 行内 review comment 触发 | 未实现；两个 review 事件被忽略                                    | 同上                                                                         | 待实现                       |
| E07 | push 触发                            | 未实现；push 被忽略                                               | 同上                                                                         | 待实现                       |
| E08 | check_run / check_suite 触发         | 未实现；被忽略                                                    | 同上                                                                         | 待实现                       |
| E09 | workflow_run / workflow_job 触发     | 未实现；被忽略                                                    | 同上                                                                         | 待实现                       |
| E10 | discussion / discussion_comment 触发 | 未实现；被忽略                                                    | 同上                                                                         | 待实现                       |
| E11 | release 触发                         | 未实现；被忽略                                                    | 同上                                                                         | 待实现                       |
| E12 | 防止机器人回复触发自身               | 已实现；忽略 Bot、自己的消息和不匹配的提及                        | webhook.test.ts                                                              | 历史真实观察到回帖事件被忽略 |
| E13 | 重复投递只对应一个任务               | 已实现；delivery 和 scoped comment 去重                           | [store.test.ts](../tests/store.test.ts)                                      | 历史真实重投通过             |

GitHub App 勾选某个事件仅表示 GitHub 会投递它。当前除符合条件的 `issue_comment.created` 外，其余事件不会创建任务，通常返回 `200 {ignored:true}`。不能把这个 HTTP 200 当成业务执行成功。

## 2. 上下文、模型和执行环境

| ID  | 能力                               | 实现状态与限制                                                              | 证据                                                                                 | 真实环境状态                    |
| --- | ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| R01 | 内网主动领取任务                   | 已实现；HTTPS claim/tool/result，不要求内网入站                             | [agent.ts](../src/agent.ts)、[pull.test.ts](../tests/pull.test.ts)                   | 历史真实通过                    |
| R02 | 调用已有 OpenClaw 模型             | 已实现；Responses、按任务隔离会话                                           | [connector.ts](../src/connector.ts)、[connector.test.ts](../tests/connector.test.ts) | 历史真实通过                    |
| R03 | 多轮客户端工具调用                 | 已实现；限定工具、轮数、响应大小和执行期限                                  | 同上                                                                                 | 历史真实通过                    |
| R04 | 读取任务 Issue/PR                  | 部分实现；标题与正文，不含完整评论历史、diff 或审查历史                     | [github.ts](../src/github.ts)、[github.test.ts](../tests/github.test.ts)             | Issue 历史真实通过              |
| R05 | 读取单个仓库文件                   | 部分实现；默认分支、指定路径、文件至多 128 KiB                              | 同上                                                                                 | 历史真实通过                    |
| R06 | 列目录、搜索代码、读取仓库树       | 未实现；没有对应工具                                                        | connector.ts；本次 list_files 请求被拒绝                                             | 待实现                          |
| R07 | 读取 PR diff、head/base 和检查日志 | 未实现；read_issue 不提供这些数据                                           | github.ts；本次 read_diff 请求被拒绝                                                 | 待实现                          |
| R08 | 固定任务 base SHA                  | 未实现；read_file 未固定 ref，读取可能跨越分支更新                          | github.ts、[contracts.ts](../src/contracts.ts)                                       | 待实现                          |
| R09 | 每任务检出仓库/隔离工作区          | 未实现；Channel 没有 checkout、clone 或工作区生命周期                       | agent.ts、contracts.ts                                                               | 待实现                          |
| R10 | 修改文件并收集 diff                | 未实现；没有编辑工具/变更产物；提示词明确禁止修改仓库                       | connector.ts；本次 apply_patch 请求被拒绝                                            | 待实现                          |
| R11 | 执行项目构建、测试或命令           | 受限；当前专用 OpenClaw 配置禁用内置工具，Channel 无执行工具                | [OpenClaw 模板](../deploy/openclaw.example.json)、本次 run_tests 请求被拒绝          | 待实现                          |
| R12 | 结构化产物、测试结果回传           | 未实现；当前结果只接受 status/text/responseId 等协议字段                    | [pull.ts](../src/pull.ts)、本次附加 changes/pullRequest 的结果被拒绝                 | 待实现                          |
| R13 | 任务查询、取消、执行恢复           | 部分实现；有管理员状态查询/人工对账；无模型运行查询、确认取消和自动续租恢复 | [server.ts](../src/server.ts)、[operations.md](operations.md)                        | 查询有历史记录；取消/恢复待实现 |

## 3. GitHub 输出与协作成果

| ID  | 能力                              | 实现状态与限制                                                 | 证据                                                                     | 真实环境状态                             |
| --- | --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| O01 | 分析结果发布为评论                | 已实现；结果落盘后交给 DeliveryWorker 发布                     | [worker.ts](../src/worker.ts)、[worker.test.ts](../tests/worker.test.ts) | 历史真实通过                             |
| O02 | 评论去重和结果不明对账            | 已实现；按任务 marker 查询；不明确时进入 unknown，不盲目重发   | github.test.ts、worker.test.ts                                           | 重投历史真实通过；网络故障场景为本地测试 |
| O03 | 创建任务分支                      | 未实现；无分支创建 API 和状态记录                              | github.ts；本次 create_branch 请求被拒绝                                 | 待实现                                   |
| O04 | 提交文件变更/推送 commit          | 未实现；token 在代码中请求 contents:read，无提交 API           | github.ts；本次 commit_changes 请求被拒绝                                | 待实现                                   |
| O05 | 创建 PR 并关联 Issue              | 未实现；pull_requests:write 权限申请不等于已经有创建 PR 的代码 | contracts.ts、github.ts；本次 create_pull_request 请求被拒绝             | 待实现；当前优先目标                     |
| O06 | 记录 commit SHA、PR URL、变更摘要 | 未实现；Task 目前只有 result/responseId/commentUrl 等输出      | contracts.ts、[store.ts](../src/store.ts)                                | 待实现                                   |
| O07 | 发布代码 review / 行内建议        | 未实现；普通 PR 会话评论不能替代 review                        | github.ts                                                                | 待实现                                   |
| O08 | 合并 PR、修改工作流、发布版本     | 未实现；不属于本次 Issue→PR 的默认授权                         | github.ts、架构边界                                                      | 不纳入本次闭环                           |

## 4. 权限、持久性和部署

| ID  | 能力                                | 实现状态与限制                                       | 证据                                                                                         | 验收范围                           |
| --- | ----------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| S01 | 安装范围与发起人权限分离            | 已实现；仓库身份匹配，actor 需 write/maintain/admin  | github.test.ts、pull.test.ts                                                                 | 本次本地通过；真实授权评论历史通过 |
| S02 | 每次工具和外部回写重新授权          | 已实现，当前仅覆盖读取与评论；未来写仓须增加对应校验 | 同上、worker.test.ts                                                                         | 本次本地失权用例通过               |
| S03 | 模型不能覆盖目标仓库/Issue/身份     | 已实现；可信上下文来自已保存任务，工具参数严格检查   | webhook.test.ts、pull.test.ts                                                                | 本次本地通过                       |
| S04 | Webhook 持久化后 ACK                | 已实现                                               | server.test.ts、store.test.ts                                                                | 本次本地通过                       |
| S05 | 云端 assignment、lease、结果幂等    | 已实现；单可信 worker，未知任务阻塞继续执行          | [pull-store.test.ts](../tests/pull-store.test.ts)、pull.test.ts                              | 本次本地通过                       |
| S06 | 内网 journal、重启和重复结果处理    | 已实现；运行中断转 unknown，结果重传不重跑模型       | [agent-store.test.ts](../tests/agent-store.test.ts)、[agent.test.ts](../tests/agent.test.ts) | 本次本地通过                       |
| S07 | 写分支/commit/PR 的副作用日志与对账 | 未实现；不能将评论去重机制直接视为写仓幂等           | github.ts、store.ts                                                                          | 待实现                             |
| S08 | 文件路径、base SHA、分支写入策略    | 部分实现；有读文件路径检查，没有写仓策略             | github.test.ts                                                                               | 读策略本次本地通过；写策略待实现   |
| S09 | 多租户、多 worker 路由              | 未实现；实例共享的一个 connector 身份不构成租户隔离  | contracts.ts、pull-store.test.ts                                                             | 不纳入本次闭环                     |
| S10 | 原生/Docker、外部 HTTPS/Caddy       | 已实现；配置生成、生命周期、持久卷和 secret 引用     | config/deploy/agent-deploy/lifecycle/cli 测试                                                | 本次本地通过；容器/公网为历史验收  |

## 本次测试记录

| 检查                                 | 实际结果                                                                                                                      | 能证明什么                                  | 不能证明什么                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| `npm test`                           | 88 项通过，0 失败                                                                                                             | 当前实现及已有异常处理符合这些测试          | Issue→代码→PR 已可用         |
| 签名事件能力探针                     | issue_comment 提及可标准化；表 E04–E11 的 12 种事件名均返回 null                                                              | 非评论事件在入口被过滤                      | GitHub App 当前实际订阅列表  |
| 内存 SQLite + 实际本地 HTTP 工具探针 | claim 200；read_issue 200；list_files/read_diff/apply_patch/run_tests/create_branch/commit_changes/create_pull_request 均 400 | 当前 HTTP 协议拒绝这些未实现工具名          | GitHub API 是否允许对应操作  |
| 结构化结果探针                       | 加入 changes/pullRequest 字段返回 400                                                                                         | 现有结果协议不能传递这种变更/PR 产物        | 新协议的正确性               |
| 源码核对                             | 固定只读工具、禁止修改的模型 instructions、contents:read、仅评论发布接口                                                      | 写代码闭环缺少实现，不只是 Webhook 配置缺失 | 当前线上实例没有其他运行故障 |

上述能力探针在本机运行，GitHubClient 为替身，没有调用真实模型、创建 GitHub 内容或改动运行中的服务。它们是本轮的一次性诊断，不是新增能力验收测试。现有测试可通过 `npm test` 重跑。

历史真实链路的原始证据见 [2026-11-22 验证记录](outbound-validation-20261122.md)。本台账不将历史验收描述为本轮重新验证。

## 当前结论与下一步

当前只完成了分析回帖闭环。Issue→代码→PR 是需要补齐的执行能力，不应通过移除提示词限制或开启全部事件来冒充完成。原计划中的 [M4 受控 Git Executor](implementation-plan.md#后续里程碑首轮不开放未验证能力) 尚未实现。

本轮先进行文档治理与同类产品复用研究。此前列出的自建工作区/发布器建议已撤回为待比较候选；编码、测试与会话能力优先复用已有 Runtime、Agent SDK 或执行后端。不能把早期 M4 计划直接当成本轮已经确定的实现方案。具体偏差和待决策问题见[治理记录](governance-review-20261122.md)。

以下仅是 Issue→代码→PR 的验收目标，**不是已批准的实现设计**，也不限定必须由 Channel 自研实现。后续每完成一项，都更新上面的对应 ID 和证据链接。

| 阶段     | 验收项                                                                                   | 必须留下的证据                                             |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 任务入口 | 明确 Issue 的启动规则：保留显式 @ 指令，或配置标签/指派触发；普通 Issue 不应意外启动任务 | 触发事件、actor、Issue、授权结果、taskId                   |
| 工作区   | 固定服务器确定的仓库和 base SHA，按任务隔离                                              | repositoryId、base SHA、工作区记录；跨仓和路径越界拒绝测试 |
| 编码     | Runtime 能定位代码、修改文件并产生实际 diff                                              | 文件清单、diff、变更摘要；无改动不得假称完成               |
| 项目验证 | 在隔离环境运行事先配置的构建/测试；命令配置不由 Issue 内容直接决定                       | 命令、退出码、日志与产物；未运行和失败必须如实标注         |
| 发布校验 | 受控发布层重查 actor/安装权限、校验基线、文件范围和任务分支                              | 权限撤销、base 变化、路径越界、默认分支写入拒绝的测试      |
| 创建成果 | 发布 commit，创建关联 Issue 的草稿 PR                                                    | commit SHA、head/base、PR URL、测试结果；不自动合并        |
| 故障恢复 | commit/PR 网络结果不明时查询对账，避免重复创建或覆盖其他变更                             | 丢响应、重启、重复回传、分支冲突和失权场景证据             |
| 真实验收 | 在明确授权的测试仓库，以一个可判定的小型 Issue 完成上述过程                              | Issue→task→diff→测试→commit→PR 的完整链接与状态            |

台账维护规则：新增能力先加行；实现后链接代码和自动化测试；真实部署通过后再填真实验收证据。代码存在、自动化测试通过、真实可用三个状态分别记录。
