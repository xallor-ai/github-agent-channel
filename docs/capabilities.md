# Channel 能力与验收台账

成熟版目标见[产品契约](product-contract.md)；本表只记录实现与证据。

目标是让 GitHub 任务进入用户的 Agent 执行环境并产生可验证的工作成果。当前优先闭环为 **Issue → 修改代码 → 测试 → 创建 PR**。评论是交互与反馈方式之一，分析回帖成功不代表这个目标已经实现。

本表适用当前 v2 实现（2026-11-25 增补版本化 PR 评审的源码与本地测试入口；真实验收按行记录）。配置、协议、状态库均不兼容旧版。代码路径在本地测试；真实环境列明确区分实际验收、故障注入测试与未实现范围。

**待交付的功能不计入现有证据：** #21 的逐事件送达/处理、澄清必答和版本取代，#22 的原评论收件 reaction，#23 的门禁事实与工具轨迹，见[功能地图](product-features.md)。已收到活动、能读 diff 或已发评论均不能替代这些验收。

## 状态和证据口径

- **已实现**：代码存在，并列出测试或源码入口；不自动代表线上已验收。
- **部分实现**：只支持表中明确写出的子集。
- **未实现**：缺少执行路径，不能通过增加事件订阅或修改提示词使其生效。
- **受限/拒绝**：当前代码主动阻止该操作；这可能是待扩展边界，不一定是程序缺陷。
- **本次本地**：本轮重新执行；GitHub 和模型使用替身，HTTP、SDK 和 SQLite 按对应测试实际运行。
- **历史真实**：引用已有公网 GitHub/OpenClaw 验收记录；本轮没有重新执行该真实场景。
- **待验收**：尚无对应环境的成功证据。未来新增能力必须单独验收。

## 1. 任务入口与事件

| ID  | 能力                                 | 实现状态与限制                                                                | 证据                                                                         | 真实环境状态                       |
| --- | ------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| E01 | 接收签名 Webhook                     | 已实现；验签原始正文后解析                                                    | [webhook.ts](../src/webhook.ts)、[webhook.test.ts](../tests/webhook.test.ts) | v2真实投递/签名通过                |
| E00 | 只观察与补领 | 签名活动与可选任务原子保存；按设备、负责人、绑定修订分页。自身回执不启动模型 | [活动库测试](../tests/activity-store.test.ts) | 新策略本地验证，未生产验收 |
| E02 | Issue 评论 @App 发起任务             | 已实现；仅已启用的 created 与匹配 binding 的人类评论；明确提及时执行，普通评论只记活动                     | 同上；[outbound-e2e.test.ts](../tests/outbound-e2e.test.ts)                  | v2两轮真实评论触发通过             |
| E03 | PR 会话区评论 @App | 按绑定触发；授权领取时固定 PR 版本，开放状态或版本不匹配即拒绝 | [pull.ts](../src/pull.ts)、[GitHub 测试](../tests/github.test.ts) | 旧版 PR #4 真实回帖；固定版本路径待验收 |
| E04 | Issue 创建/标签触发                  | 新建时提及或显式 autoTriage；设置 triggerLabel 才按标签启动；assigned 未实现 | generic-tasks/webhook 测试                                                   | v2 Issue #5 opened/labeled 均通过 |
| E05 | PR 创建/更新 | 默认观察；显式 autoReview 才自动执行；签名事件保留原始 base/head 身份 | [webhook.ts](../src/webhook.ts) | 旧版 PR #6 真实触发；H1/H2 版本验收待做 |
| E06 | PR review / 行内 review comment 触发 | 未实现；两个 review 事件被忽略                                                | 同上                                                                         | 待实现                             |
| E07 | 非删除分支 push | 记录 ref/SHA，只观察不执行 | [Webhook 策略](../src/webhook.ts) | 本版待真实验收，旧版的 push 执行不是本版承诺 |
| E08 | check_run / check_suite 触发         | 未实现；被忽略                                                                | 同上                                                                         | 待实现                             |
| E09 | workflow_run / workflow_job 触发     | 未实现；被忽略                                                                | 同上                                                                         | 待实现                             |
| E10 | discussion / discussion_comment 触发 | 未实现；被忽略                                                                | 同上                                                                         | 待实现                             |
| E11 | release 触发                         | 未实现；被忽略                                                                | 同上                                                                         | 待实现                             |
| E12 | 防止机器人回复触发自身               | 已实现；忽略 Bot、自己的消息和不匹配的提及                                    | webhook.test.ts                                                              | v2两条机器人事件200 ignored        |
| E13 | 重复投递只对应一个任务               | 已实现；delivery 和 scoped comment 去重                                       | [store.test.ts](../tests/store.test.ts)                                      | v2 GitHub Redeliver 同任务、单回帖 |

默认关注支持范围与当前安装、订阅的交集；`events` 仅收窄观察范围。观察不等于委派：默认明确提及才执行，自动分诊/评审另行选择。当前新策略的真实 GitHub 验收未完成。详见[绑定指南](agent-self-service.md)。

## 2. 上下文、模型和执行环境

| ID  | 能力                               | 实现状态与限制                                                                                                       | 证据                                                                                | 真实环境状态                                                   |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R01 | 内网主动领取任务                   | 已实现；HTTPS claim/tool/result，不要求内网入站                                                                      | [agent.ts](../src/agent.ts)、[pull.test.ts](../tests/pull.test.ts)                  | v2真实HTTPS出站通过                                            |
| R02 | Runtime 调用                       | 已实现 OpenClaw 与官方 ACP SDK 适配器；type 必填                                                                     | [runtime-factory.ts](../src/runtime-factory.ts)、runtime-factory/acp-connector 测试 | OpenClaw v2 真实评审、OpenCode 1.3.17 ACP 编码均通过 |
| R03 | 多轮客户端工具调用                 | 已实现；边界结构校验后处理工具/文本，限定工具、轮数、响应大小和执行期限                                              | [connector.ts](../src/connector.ts)、connector.test.ts                              | OpenClaw v2真实Issue读取续调用通过；双工具模型探针使用合成数据 |
| R04 | 读取任务 Issue/PR                  | 部分实现；标题与正文，不含完整评论历史、diff 或审查历史                                                              | [github.ts](../src/github.ts)、[github.test.ts](../tests/github.test.ts)            | v2 真实 Issue/PR 正文读取通过 |
| R05 | 读取单个仓库文件 | PR 按固定 head 读取；非 PR 沿用默认分支。GitHub Contents 单文件至多 128 KiB | [github.ts](../src/github.ts)、[测试](../tests/github.test.ts) | 旧版默认分支读取通过；PR 版本读取待真实验收 |
| R06 | 搜索代码与上下文 | OpenClaw 深评可对任务快照搜索字面量、返回路径与行号；ACP 使用现有 harness 工具 | [快照测试](../tests/review-snapshot.test.ts) | ACP 编码曾实测；OpenClaw 深评待验收 |
| R07 | 读取 PR 差异 | 同仓开放 PR 按指定 base/head 比较语义列文件、状态、改名与可用补丁；文件数量和字节上限有遗漏提示。无 CI 日志 | [变更采集](../src/github-pull-context.ts)、[GitHub 测试](../tests/github.test.ts) | 待真实 opened/synchronize |
| R07a | 深评只读源码 | 连接器按授权自动获取同仓 PR 指定提交并复用本地 Git 对象库；可读未改文件，搜索结果有截断标志 | [范围及限制](pr-review.md)、[快照测试](../tests/review-snapshot.test.ts) | 待真实未改调用方和跨版本隔离验收 |
| R08 | 固定版本 | PR 校验双方仓库和 base/head；ACP 编码要求工作区符合目标版本，不自动切换；仓库任务 OpenClaw 读取仍走默认分支 | [GitHub 客户端](../src/github.ts)、[工作区](../src/runtime-workspace.ts) | 旧版 draft PR parent/base 有实证；PR 评审路径仅本地 |
| R09 | 仓库与工作区                       | 部分实现；映射干净独立 clone，校验 origin，拒绝隐藏修改的索引标志；不自动 clone/重置/分配 sandbox                    | [runtime-workspace.ts](../src/runtime-workspace.ts)                                 | 本地通过；不是多租户隔离                                       |
| R10 | 修改文件并收集 diff                | ACP 委托 harness 编辑，保留 BOM 收集实际 UTF-8 文件变更；拒绝改 HEAD、特殊模式/超限文件                              | acp-connector.test.ts                                                               | 真实 OpenCode 修改单文件并发布 PR #4 |
| R11 | 执行项目验证                       | 运行管理员配置的验证命令，记录退出码/日志；失败、未知或验证前后候选文件变化均禁止发布                                | acp-connector.test.ts                                                               | 真实项目独立 typecheck/format/test exit 0；CI 155 项通过 |
| R12 | 结构化成果                         | 已实现必需 outcome：text/artifacts/publication；产物与发布回执分别存储                                               | [outcomes.ts](../src/outcomes.ts)、generic-outbound.test.ts                         | 真实 change_set/test_report/outcome/PR receipt 均持久化 |
| R13 | 运行状态与恢复                     | 记录 Runtime session/run handle；ACP 可请求取消，但不保证后代停止；无自动 resume 或远端运行查询                      | agent/acp-connector/generic-outbound 测试                                           | 部分实现；未知状态人工对账                                     |

## 3. GitHub 输出与协作成果

| ID  | 能力                          | 实现状态与限制                                                             | 证据                                                  | 真实环境状态                           |
| --- | ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| O01 | 分析结果评论发布              | 已实现显式 comment publication；none 则保存成果并 skipped                  | worker/generic-outbound 测试                          | v2两轮真实评审回帖通过                 |
| O02 | 评论去重和结果不明对账        | 已实现；按任务 marker 查询；不明确时进入 unknown，不盲目重发               | github.test.ts、worker.test.ts                        | v2重投单回帖通过；网络故障仍为本地测试 |
| O03 | 创建任务分支                  | 已实现服务端派生 channel/task-id 分支，冲突拒绝                            | [github-publication.ts](../src/github-publication.ts) | 真实 PR #4 的服务端任务分支通过 |
| O04 | 提交文件变更                  | 已实现 Octokit blob/tree/commit/ref；只为显式 writePolicy 申请写权限       | github-publication.test.ts                            | 真实 App Git Data 提交 ccf672dd 通过 |
| O05 | 创建关联 Issue 的 PR          | 已实现默认拒绝、基线/路径/权限校验后创建 draft PR；不自动合并              | github-publication/generic-outbound 测试              | Issue #3 → 实际修改 → 验证 → PR #4 通过 |
| O06 | 记录代码和 PR 成果            | 已实现 change_set/test_report/outcome/publicationReceipt；无旧文本/URL别名 | store/generic-outbound 测试                           | 真实云端 outcome/receipt、内网 journal reported |
| O07 | 代码 Review / 行内意见 | 部分实现：按仓库显式授权对固定提交发正文型 COMMENT；回执含 GitHub ID/URL，未知结果先读回核实。无行内、审批、请求修改 | [原生 Review 测试](../tests/github-review.test.ts)、[对账](operations.md) | 待真实 commit/Review 回执；普通评论不计 |
| O08 | 合并 PR、修改工作流、发布版本 | 未实现；不属于本次 Issue→PR 的默认授权                                     | github.ts、架构边界                                   | 不纳入本次闭环                         |

## 4. 权限、持久性和部署

| ID  | 能力                             | 实现状态与限制                                                                              | 证据                                                                                         | 验收范围                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| S01 | 安装范围与发起人权限分离         | 已实现；仓库身份匹配，actor 需 write/maintain/admin                                         | github.test.ts、pull.test.ts                                                                 | 本次本地通过；真实授权评论历史通过                   |
| S02 | 每次工具和外部回写重新授权       | 已实现；读取、评论及每次 Git Data/PR 写入前均重新授权                                       | github.test.ts、github-publication.test.ts、worker.test.ts                                   | 本次本地失权用例通过                                 |
| S03 | 模型不能覆盖目标仓库/Issue/身份  | 已实现；可信上下文来自已保存任务，工具参数严格检查                                          | webhook.test.ts、pull.test.ts                                                                | 本次本地通过                                         |
| S04 | Webhook 持久化后 ACK             | 已实现                                                                                      | server.test.ts、store.test.ts                                                                | 本次本地通过                                         |
| S05 | 云端 assignment、lease、结果幂等 | 已实现；按设备与绑定修订领取，未知任务阻塞继续执行                                                 | [pull-store.test.ts](../tests/pull-store.test.ts)、pull.test.ts                              | 本次本地通过                                         |
| S06 | 内网 journal、重启和重复结果处理 | 已实现；运行中断转 unknown，结果重传不重跑模型                                              | [agent-store.test.ts](../tests/agent-store.test.ts)、[agent.test.ts](../tests/agent.test.ts) | 本次本地通过                                         |
| S07 | 写仓副作用与对账                 | 部分实现；publication 状态和 receipt 持久化，未知不重放；中间 blob/commit/branch 不自动恢复 | github-publication/worker 测试                                                               | 丢响应、失权、冲突本地通过                           |
| S08 | 写路径、基线与分支策略           | 已实现固定 baseBranch、base SHA 校验、任务分支、路径/模式/数量/大小限制                     | github-publication.test.ts                                                                   | 本地通过；写权限需显式配置                           |
| S09 | 多设备领取与隔离 | 已实现按设备和有效绑定修订领取；不提供企业多租户隔离 | [双仓回归](../tests/self-service-e2e.test.ts) | 两个设备身份、两个 bridge 均运行于同一台内网主机；见下表 |
| S10 | 部署与配置                       | OpenClaw 原生/Docker、external/Caddy；ACP 仅原生连接器；旧库拒绝无迁移                      | deploy/agent-deploy/schema 测试                                                              | v2 OpenClaw Docker 与 OpenCode 原生 ACP 均完成真实验收 |

## 仓库自助接入验收

2026-11-24 在部署版本 `f54b8e8` 验收，以 [#14 现场记录](https://github.com/xallor-ai/github-agent-channel/issues/14#issuecomment-7130728427) 为准。升级服务端使用新云任务库；下列日常仓库操作没有改 ECS 配置或重启服务。

| 场景 | 实际结果 | 证据范围 |
| --- | --- | --- |
| 登记与停用 | `xallor-agent` 配对后从内网启用目标仓库（修订 1），停用（2）后真实投递被忽略，再启用（3）后回帖 | 真实 GitHub、CLI 与服务端回执 |
| 离线与隔离 | 目标设备离线时提及进入队列；另一设备未抢领。上线后原任务成功回帖，原仓库亦能独立反馈 | 同机双设备身份、双仓、只读 OpenClaw；不代表跨物理机或代码写入 |
| 故障边界 | 排队满 24 小时、错误租约、旧修订和重复结果 | [自动化测试](../tests/self-service-e2e.test.ts)，未在线注入这些故障 |

## 本次验证与限制

- 自动化结果见 [v2 验证记录](runtime-neutral-validation-20261122.md)。包括真实本地 HTTP/SQLite、官方 ACP SDK 子进程、实际 Git 文件变化、验证命令和 Octokit transport 测试。
- Docker external/Caddy 隔离测试已验证 v2 路由、签名、UID、持久性及出站结果；GitHub/模型行为为合成 fixture。
- v2已部署并完成[真实代码评审闭环](channel-review-validation-20261123.md)：两轮评审、重投去重、自身事件忽略、两端结果确认；此前不包含编码验收；现已补充[真实 ACP 编码与事件验收](acp-live-validation-20261124.md)，明确列出版本、任务、PR、失败及修正。
- workspace 原生进程不是 sandbox；不支持自动恢复未知执行、并发多租户或全部 GitHub events。

当前接口与职责见 [实现地图](implementation-map.md)，使用方式见 [OpenClaw](setup.md) 和 [ACP](acp-setup.md)。每项能力独立维护源码、本地证据与真实验收，禁止用单一“完成”标志代替。

2026-11-24 免提及测试：只读 OpenClaw、仅 github-agent-channel 绑定启用 issues.opened、issue_comment.created、pull_request.opened/synchronize；[Issue 创建](https://github.com/xallor-ai/github-agent-channel/issues/15#issuecomment-7127861955)、[普通评论](https://github.com/xallor-ai/github-agent-channel/issues/15#issuecomment-7127878845)、[PR 会话评论](https://github.com/xallor-ai/github-agent-channel/pull/16#issuecomment-7127972710) 已回帖。PR #16 的第一次 opened 已受理，但第三次工具请求 503，执行失败，无发布回执；其后普通评论成功是独立任务，不覆盖该失败。

**工具读取降级与失败说明（C3/C5/C8）：** 已授权读取不能提供文件时返回有界原因；确认的模型输出失败可在开放线程给出状态通知；未知状态不重跑。本地 GitHub、Pull 和发布 worker 回归；运维边界见[失败回执](operations.md#工具读取和失败回执)。

固定 PR 准备阶段与模型派发阶段的失败分类、同设备不同仓库的基础回复隔离、按标记查找不明 Review 回执均有本地回归；尚非生产故障注入验证。
