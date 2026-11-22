# 历史计划：GitHub Agent Channel V1

> 当前网络方向已修正为内网主动连接ECS；云端直连Runtime不再支持。部署与协议以 [主动连接计划](outbound-connector-plan.md) 和 [运维说明](operations.md) 为准。本文早期设计/验收保留作历史记录。

> 本文的 M1–M3 是分析回帖里程碑，不是产品完整边界；M4 的受控 Git Executor 是早期候选方向，不能越过本轮复用评估直接实施。当前模块见[实现地图](implementation-map.md)，目标差距见[治理记录](governance-review-20261122.md)。

> 执行方式：按任务使用测试驱动开发，独立评审设计与实现；每项记录验证结果，按里程碑交付。当前先交付可运行的分析与回帖闭环，不把它称为完整写代码 Agent。

**Goal:** 将 GitHub 中已授权的 @mention 转换为持久任务，交给用户已有 Runtime 分析，并通过 Channel 受控回写。

**Architecture:** 单进程模块化 Node 服务；Octokit 负责 GitHub App 协议，SQLite 负责任务与操作状态，配置以 JSON/YAML 和环境变量引用提供。OpenClaw Responses Connector 通过调用方执行的 function tools 使用受限 GitHub 能力，不把 GitHub Token 交给模型。

**Tech Stack:** Node.js 24、TypeScript、node:sqlite、@octokit/app、@octokit/webhooks、Zod、YAML、node:test。

**Spec:** [架构与社区对照](architecture.md)。架构是长期目标，本计划明确首个交付范围及后续阶段。

## Global Constraints

- 仓库公开：`xallor-ai/github-agent-channel`。开发分支 `codex/v1-foundation`，不自动合并。
- 仅接收配置中 installation ID + repository ID 匹配的 `issue_comment.created`；忽略 Bot、自身回写和非明确提及。
- Webhook secret、App private key、OpenClaw gateway token 均由环境变量引用，不能写入日志或配置回执。
- 首个闭环只提供读取当前任务 Issue/PR、读取同仓文件和最终回帖；不允许模型执行任意写仓、工作流修改、merge 或 Shell push。
- 验签成功不等于调用者有权发起任务；使用 installation-scoped API 核验 actor 当前仓库角色，默认允许 admin/maintain/write。
- 任一网络状态不明都不能转换成“成功”；OpenClaw HTTP 超时/进程中断后不自动重放任务。
- 同一 binding 的任务覆盖整个外部执行期间串行；unknown 会阻塞后续任务，管理端明确处理后才放行。
- GitHub 写回复先尝试按 task marker 对账；外部效果无法确认时标为 unknown，不盲目重试。
- 公共仓库文档不包含真实服务器地址、登录口令、App private key 或 provider key。

## File Map / Interfaces

| 文件 | 职责 |
| --- | --- |
| `src/contracts.ts` | Task、Config、RuntimeConnector、GitHubClient 接口 |
| `src/config.ts` | 严格配置校验、环境引用、有效快照/原子更新 |
| `src/store.ts` | SQLite Inbox/Task 的唯一性、串行领取、终态和重启恢复 |
| `src/github.ts` | App token、actor/repo核验、任务内读取、marker回帖 |
| `src/webhook.ts` | 原始请求验签、提及、可信任务标准化 |
| `src/connector.ts` | Responses 请求与 function-call/result 循环；显式能力限制 |
| `src/worker.ts` | Task 执行、每次工具调用授权、结果持久化与回帖 |
| `src/server.ts`, `src/main.ts` | HTTP、健康状态、已认证任务查询、worker启动 |
| `tests/*.test.ts` | 配置、持久性、鉴权、Webhook、Connector与HTTP闭环 |
| `deploy/compose.yaml` | 独立 Channel + OpenClaw 网络与持久卷 |

## Task 1 — 配置与持久任务（M1）

- [x] 先写 `tests/config.test.ts`：拒绝明文密钥字段/重复binding、丢失环境变量、非法URL；无效 update 保留快照，revision冲突拒绝。
- [x] 先写 `tests/store.test.ts`：同delivery、同comment重投只有一个任务；不同binding可领取，同binding running/unknown阻塞；重启running变unknown，queued保留；已完成回复不会再次投递。
- [x] 运行 `npx tsx --test tests/config.test.ts tests/store.test.ts` 确认缺失实现导致失败。
- [x] 实现 ConfigManager、TaskStore，数据库 WAL、参数化 SQL、事务领取；运行测试和 `npm run typecheck`。

## Task 2 — GitHub 接入和授权（M2）

- [x] 测试 raw-body 签名有效/失效、created/edited、Bot、自身标记、提及单词边界、仓库/installation不匹配。
- [x] GitHub fake transport 测试：API返回 repo ID与绑定不一致或actor权限不足时拒绝；模型不能指定另一个repo/issue；限量读文件。
- [x] 实现 Octokit App client 与真实 raw webhook verification，网络故障失败关闭；不自造JWT或签名算法。
- [x] 验证事件成功落盘才返回202，重复返回已受理task，不等待Runtime响应。

## Task 3 — Connector 与只读闭环（M3）

- [x] 用fake fetch transport 模拟 OpenClaw 返回正常文本、function call、失败、invalid JSON和超时；测试最多工具轮次、响应大小与失败分类。
- [x] Responses每个task使用独立session key；同任务工具续调用 `previous_response_id`，避免不同调用者共用会话历史。长期repo主会话复用后续显式开启。
- [x] 实现 `RuntimeConnector.run(task, invokeTool)`，只提供读取当前任务与同仓文件的function tools，所有scope由worker绑定。
- [x] 测试 actor 在运行中失权时阻止工具和最终回帖；成功结果先持久化再投递；网络未知不自动replay。
- [x] 完成本地 HTTP 签名事件 → SQLite → fake Runtime → fake GitHub 回帖端到端测试。

## Task 4 — 容器与真实 OpenClaw 原型（M0/M3 联调）

- [x] 在指定服务器隔离部署官方 npm 包 OpenClaw 2026.11.3，记录版本与包 integrity；镜像拉取失败，所以不报告不存在的已部署镜像 digest。
- [x] 开启私网/回环 Responses API，专用agent默认不携带GitHub凭据，限制无关本地工具。
- [x] 提供Compose、配置示例、运行/恢复说明；检查健康端点不等于模型任务成功。
- [x] 真实文本、read_issue/read_file 多轮工具请求通过；保留 400、旧配置和 Tool Search 超时的排查记录。
- [ ] 真实 GitHub App E2E：等待用户创建并安装 App 与配置 HTTPS Webhook；配置步骤和本地签名 fixture 验证已提供。

## 后续里程碑（首轮不开放未验证能力）

| 阶段 | 工作与验收 |
| --- | --- |
| M4 | 受控Git Executor接收限定patch/文件变更，验证仓库、work branch、base SHA、路径；创建PR；测试越仓、默认分支、workflow路径拒绝 |
| M5 | OpenClaw异步run查询/取消与恢复探针；当前HTTP无法确认远端取消时维持unknown；任务管理与Outbox审计回放 |
| 扩展 | Repo Webhook Adapter、其他Runtime Connector、外部队列/多实例，仅在契约测试通过后启用 |

## 已知接口限制与设计选择

OpenClaw 官方 Responses 接口支持 `input`、`previous_response_id` 和 client function tools；共享token可拥有较高Gateway权限，因此仅接入专用受限agent和受控网络。接口的实际版本、取消/查状态能力在服务器原型中核验，不宣称全部Connector flags可用。

首轮采用每task隔离会话并对binding串行，避免尚未实现的跨用户历史隔离造成数据混用；后续扩展会话复用需附独立授权验证。收到的仓库文字作为不可信输入，不能改写安装、仓库或调用者身份。

## 验证记录

执行结果记录到 [进度记录](progress.md)，包含红/绿测试、提交、独立评审、真实部署与未验证范围。
