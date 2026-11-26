# 文档索引与维护规则

GitHub Agent Channel 是通用 GitHub 通道。当前实现严格 v2 契约、OpenClaw/ACP 适配器和受控评论/PR 发布；本地代码验收与真实环境验收分别记录。不兼容旧配置、旧协议或旧状态库。

| 目的                                  | 当前入口                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 成熟版范围与验收条件 | [产品契约](product-contract.md) |
| PR 评审配置、限制与分期验收 | [使用指南](pr-review.md) · [实施方案](superpowers/plans/2026-11-25-pr-review-context.md) |
| 产品功能细则与规划 | [功能地图与实施顺序](product-features.md) · [负责人反馈与收件回执](owner-feedback-spec.md) · [PR 合并判断](pr-merge-assessment.md) |
| 负责人、活动与执行边界 | [#20 产品对照](repository-owner-boundary.md) |
| 设备配对与仓库自助登记 | [命令与示例](agent-self-service.md) |
| 仓库动态接入设计与交付边界 | [绑定生命周期](binding-lifecycle.md) |
| Agent 如何委派、请求评审和核验回执 | [GitHub Agent Channel skill](../.agents/skills/github-agent-channel/SKILL.md) |
| 全部模块与调用链                      | [实现地图](implementation-map.md)                                                                        |
| 每项能力与证据                        | [能力台账](capabilities.md)                                                                              |
| 架构职责与未覆盖范围                  | [架构](architecture.md)                                                                                  |
| 必须字段、事件、PR policy、新库和切换 | [v2 契约](protocol-v2.md)                                                                                |
| 配置 OpenClaw 读取分析适配器          | [OpenClaw 接入](setup.md)                                                                                |
| 配置已有编码 harness                  | [ACP 接入](acp-setup.md)                                                                                 |
| 自建公网服务端（可选）                | [ECS 部署](ecs-setup.md)                                                                                 |
| 日志、更新和未知状态对账              | [运维](operations.md)                                                                                    |
| 本次实现依据与步骤                    | [设计与复用边界](runtime-neutral-design.md)、[实施计划](superpowers/plans/2026-11-22-runtime-neutral.md) |
| 本地协议与 SDK 验证（2026-11-22）                          | [v2 验证记录](runtime-neutral-validation-20261122.md)                                                    |

GitHub App 平台教程引用 modern-github-book 附录 B/C，链接在适配器/服务端教程内。平台可订阅的事件不等于 Channel 已实现的事件。

后续复核与逐项治理状态见 [v2 代码与文档复核](code-document-review.md)。其中区分修正前证据与当前关闭状态，不以历史测试通过覆盖新发现。

仓库登记、离线恢复与停用见[真实双仓验收](https://github.com/xallor-ai/github-agent-channel/issues/14#issuecomment-7130728427)。真实 OpenClaw 评审、重投去重及连续复核证据见 [Channel v2 真实评审闭环](channel-review-validation-20261123.md)。ACP 编码→PR→Channel 评审及逐项事件检查另见[真实编码验收](acp-live-validation-20261124.md)。

## 保留的历史证据

| 文档                                               | 范围                                              |
| -------------------------------------------------- | ------------------------------------------------- |
| [治理与偏差审计](governance-review-20261122.md)    | 更正前基线6c51ead；不能当作当前功能状态           |
| [社区复用快照](community-reuse.md)                 | 固定历史源码阅读，不代表已部署该产品              |
| [OpenClaw 原型](deployment-validation.md)          | 2026-11-16 真实模型、合成工具                     |
| [旧部署验收](deployment-validation-20261122.md)    | 旧里程碑的 Docker/合成外部服务                    |
| [v1 主动连接验收](outbound-validation-20261122.md) | 当时一个仓库的真实读取/回帖；不是 v2 编码 PR 验收 |

旧 V1 实施计划、直连部署设计/计划、旧进度日志和 v1 协议计划已从当前树删除；需要追溯时查 Git 历史，不保留过渡实现或旧操作入口。

## 维护责任

- 实现地图维护模块/调用链；能力台账维护实现与分层证据；架构维护职责；教程维护当前操作；验证记录保持原日期与环境事实。
- 源码决定“当前怎样运行”，产品契约记录已确认的目标。差距显式记录，不能将部分实现重新定义为产品目标。
- 新能力同步台账、适配器/服务端配置、示例和验证记录；不能只改 README。
- 方案、源码研究、自动化测试、真实验收分别标注。没有真实证据的能力不得写成线上可用。
