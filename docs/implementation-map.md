# 当前实现地图：Channel v2

状态：本次实现纠偏后的源码地图，2026-11-22。目标是通用 GitHub Channel；目前实现 OpenClaw 分析适配器和 ACP 编码适配器。真实模型/仓库验收范围单列在[能力台账](capabilities.md)。

## 数据与调用链

1. GitHub → server/webhook 验签与触发规则 → SQLite 保存 source、target、授权范围 → 202。
2. 用户执行环境中的 agent 主动调用 v2 claim；服务端持久化 assignment 并校验 actor 后下发。
3. agent 写本地 journal，通过 runtime-factory 调用选定 Runtime；运行标识先落盘并回传 execution。
4. Runtime 编辑与执行归已有 harness；Channel 只收集有界产物和受控验证结果，不实现模型规划循环。
5. result 必须为 status + 嵌套 outcome。云端保存摘要和 outcome 后 ACK；重复相同结果只确认，冲突拒绝。
6. publication=none → skipped；comment/PR → worker 重新授权，按 policy 发布并保存 publicationReceipt；不确定则 unknown。

规范模型没有 task 根级 commentId/issueNumber/result/commentUrl。commentId 只作为原始评论事件的 source.commentId；目标号在 target.number；文本在 outcome.text；外部地址在 publicationReceipt.url。产物必须明确包含 artifacts 和 publication，不做兼容推断。

## 全部生产模块

| 文件                                                  | 实际职责与边界                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [main.ts](../src/main.ts)                             | 一次性加载服务端配置，装配 HTTP/队列/发布 worker；只显示安全 schema 拒绝诊断                              |
| [server.ts](../src/server.ts)                         | Webhook、健康、管理员状态与人工对账；严格按 target 校验发布 receipt URL                                   |
| [webhook.ts](../src/webhook.ts)                       | 验签、事件/action/binding/人类身份/触发规则；构造 source 与 target                                        |
| [contracts.ts](../src/contracts.ts)                   | 规范 Task、RuntimeResult、Artifact、PublicationRequest/Receipt 和适配器接口                               |
| [config.ts](../src/config.ts)                         | 云端 schema；事件与 PR writePolicy；仅 loadConfig，无运行中设置 API                                       |
| [secrets.ts](../src/secrets.ts)                       | File/Env 互斥引用；PEM 原样和 token trim；不含凭据轮换功能                                                |
| [store-schema.ts](../src/store-schema.ts)             | 只建立 schema v2；旧格式拒绝，绝不转换或删除旧数据                                                        |
| [store.ts](../src/store.ts)                           | 云端任务、delivery 去重、assignment、outcome、runtime handle、publicationReceipt；无旧 claim/finish       |
| [pull.ts](../src/pull.ts)                             | 只处理 `/connector/v2/claim` 及 `tasks/<id>/tool`、`result`、`execution`；lease/actor 与严格 outcome 校验 |
| [github.ts](../src/github.ts)                         | 官方 Octokit App token/actor 校验、任务目标读取、评论与 PR 发布入口                                       |
| [github-publication.ts](../src/github-publication.ts) | 显式 writePolicy；基线/路径/模式检查；服务端分支、Git Data commit 和 draft PR；每次写入重授权             |
| [worker.ts](../src/worker.ts)                         | 只发布已持久化 outcome：comment 或 pull_request；none 已在存储置 skipped                                  |
| [outcomes.ts](../src/outcomes.ts)                     | source/target/runtime/产物/发布 schema；有界 payload，拒绝额外身份字段                                    |
| [agent-config.ts](../src/agent-config.ts)             | type 必填：openclaw 或 acp；命令、工作区、环境引用由管理员配置                                            |
| [agent-store.ts](../src/agent-store.ts)               | schema v2 journal 和排他锁；执行前持久化、保存运行 handle、未确认 outcome 重传；无迁移                    |
| [agent.ts](../src/agent.ts)                           | 出站 bridge：claim→journal→适配器→保存 outcome→result ACK；不实现编码循环                                 |
| [runtime-factory.ts](../src/runtime-factory.ts)       | 按显式 runtime.type 构造适配器，无默认 provider 和未知类型回退                                            |
| [connector.ts](../src/connector.ts)                   | OpenClaw Responses 适配器；两种受控读取工具，返回明确评论/none outcome                                    |
| [acp-connector.ts](../src/acp-connector.ts)           | 官方 ACP SDK 接入已有 harness；预取授权 Issue、session、权限请求、编辑结果与验证命令                      |
| [runtime-workspace.ts](../src/runtime-workspace.ts)   | 干净 clone 的 origin/目标 SHA/元数据检查；共用索引校验拒绝隐藏修改；收集实际变更，不 clone/reset/push     |
| [cli.ts](../src/cli.ts)                               | 初始化、校验、渲染、生命周期、agent run；不安装 harness/App 或替用户开启 writePolicy                      |
| [examples.ts](../src/examples.ts)                     | CLI init 模板源，与 deploy YAML 手动保持一致                                                              |
| [deploy.ts](../src/deploy.ts)                         | Cloud Compose、Nginx v2路由、可选 Caddy、secret 挂载和不可覆盖 bundle                                     |
| [agent-deploy.ts](../src/agent-deploy.ts)             | OpenClaw bridge 容器，无端口；ACP render 明确拒绝，使用原生 bridge                                        |
| [lifecycle.ts](../src/lifecycle.ts)                   | Compose2.20+检查、up/down/status、离线 doctor；不验证真实模型/GitHub                                      |

## 权限、存储和恢复

| 场景                         | 当前行为                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| 未启用事件或不满足触发条件   | 忽略；HTTP 200 不是任务成功                                                               |
| 签名合法但发起人无仓库写权限 | claim 时拒绝，不透露任务给执行器；写前再次复核                                            |
| 代码/PR 发布                 | binding.writePolicy 默认不存在；显式启用后只写派生任务分支，不合并、不写默认分支          |
| 执行成功/发布成功            | 两套状态；模型文本不是测试证据；outcome 与 receipt 分离                                   |
| 重启/超时/网络结果不明       | unknown，不自动 replay；执行对账只可确认为 failed，不能强行变成功                         |
| 旧数据/旧配置/旧协议         | 直接拒绝；无迁移、无别名、无 fallback。新版本使用新状态目录和卷                           |
| 工作区安全                   | 原生 ACP 不是 OS sandbox，独立 clone 与专用账户由管理员准备；不支持多个 bridge 共享工作区 |

## 配置与验证入口

- [OpenClaw](setup.md) 与 [ACP](acp-setup.md) 是不同适配器教程；[ECS](ecs-setup.md) 只是可选服务端部署。
- [新协议和部署切换](protocol-v2.md) 说明必须字段、结果限制和新状态库要求。
- [package.json](../package.json)：Node24，channel 用 tsx，start 用编译后的云 main。Docker 默认云端，agent Compose 覆盖 command；[.dockerignore](../.dockerignore) 限定构建源文件。
- [tests](../tests)：真实 SQLite、签名和本地 HTTP；GitHub transport/模型为替身。ACP 测试执行真实 SDK 子进程、Git 和验证进程，编码行为合成。
- [Docker smoke](../scripts/smoke-deployment.mjs) 使用隔离容器、Nginx、Caddy 本地 CA、真实出站协议；[fixture server](../scripts/smoke-fixture-server.mjs) 的合成发布计数存入独立 smoke.db。
- [OpenClaw smoke](../scripts/smoke-openclaw.mjs) 使用真实模型、合成读取工具；不能证明 GitHub PR。
- [CI](../.github/workflows/checks.yml) 执行格式、类型、单元/HTTP、构建与 Docker smoke。当前实测见[v2 验证记录](runtime-neutral-validation-20261122.md)。
