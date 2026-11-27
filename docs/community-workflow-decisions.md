# 社区产品对照：从收件到交付（2026-11-26）

本页补充[此前关于源码与执行环境的调研](product-research-20261124.md)。本次核对公开源码、回归用例和产品方文档，没有部署竞品或比较模型质量。表中“采用”是对本产品的选择，不是竞品对外作出的承诺。用户行为与验收口径分别维护在[功能地图](product-features.md)、[负责人反馈](owner-feedback-spec.md)与[合并判断](pr-merge-assessment.md)。

| 问题 | 核实到的社区做法 | 本产品采用什么，舍弃什么 |
| --- | --- | --- |
| 如何让委派人知道有人处理，又不刷屏？ | Claude Code Action 的[固定提交实现](https://github.com/anthropics/claude-code-action/blob/4411a9e9b0283becf4b924f7bce360fd7756c78c/src/github/operations/comments/create-initial.ts#L22-L81)把运行链接放入跟踪评论，并区分评论目标。[模式说明](https://github.com/anthropics/claude-code-action/blob/4411a9e9b0283becf4b924f7bce360fd7756c78c/docs/custom-automations.md)区分提及交互与自动化的进度展示。 | 状态可追溯，公开反馈按场景选。普通讨论不逐条发进度；👀、任务状态与最终成果各有证据。不把 CI 作业已启动等同于负责 Agent 已收件。 |
| 怎么知道新消息是回答问题还是另一项请求？ | Linear 的[Agent 交互协议](https://linear.app/developers/agent-interaction)用 Agent Session 归属活动，区分 elicitation、用户后续 prompt 与 Agent 的结果。 | 采纳“先有可关联的问题，再谈接续”。GitHub 评论本身不是 Linear session：无法区分同线程的两个请求时由用户消歧，不根据最新一条评论猜测。 |
| 增量复评在什么时候不可信？ | PR-Agent 的[固定版本回归用例](https://github.com/The-PR-Agent/pr-agent/blob/834d450ee4a2a45f987d7c1f23e81f2ec70eb456/tests/unittest/test_github_provider_incremental.py#L44-L134)分别验证提交列表不完整、正常增量和整支 rebase 后重新全评。 | 上次实际评审的范围是增量起点。不能证明差异连续，就评当前完整 PR；当前材料本身仍不全，就报告受限，不把“未看到”写成“没有问题”。不依赖提交时间推断祖先关系。 |
| 为什么“PR 检查是绿的”还不能回答能否合并？ | [Prow Tide 实现](https://github.com/kubernetes-sigs/prow/blob/5b5f4b60c5a90c1a5eba9f73a367c222bff3f326/pkg/tide/tide.go#L1108-L1127)在特定检查上下文中匹配 base SHA；[Mergify 队列生命周期](https://docs.mergify.com/merge-queue/lifecycle/)说明默认情况下外部 base 更新会重置队列验证。GitHub 自身的[合并队列](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)还对候选合并组合运行检查。 | 区分 PR head、当前 base 和队列候选提交。只读解释适用门禁及缺项，不实现另一个队列，不代替维护者入队或合并。 |
| 编码后维护者再要求修改，谁拥有分支？ | [OpenCode GitHub 实现](https://github.com/anomalyco/opencode/blob/517e6c9aa4c61dbc125e7654fc596f1d529f20d9/packages/opencode/src/cli/cmd/github.ts#L600-L665)对已有 PR 与新 Issue 使用不同的检出/推送路径，还区分同仓与 fork。 | 采纳“续改原 PR”，不复制其直接推送或 fork 权限模型。Channel 仍拥有发布控制，编码 harness 不因收到委派而得到 GitHub 写入凭据。 |
| 接管时怎样证明子 Agent 已停？ | [ACP prompt turn 协议](https://agentclientprotocol.com/protocol/v1/prompt-turn)区分客户端发起取消与原 prompt 返回 cancelled；中间可能还有未收尾的操作。 | 取消请求、执行端终止确认、GitHub 写入是否生效分别记录。其他 Runtime 使用等效证据，不被要求实现 ACP 协议。 |

**实现前的复用决定：** 保留当前 GitHub App/Octokit 作为查询和写入边界，已有 ACP SDK/harness 负责执行；复用任务关联、版本校验与发布对账。需要新增的是逐事件接收证据、待答问题归属、复评基线与合并事实查询。暂不引入新的 Agent 调度器、通用消息总线、竞品的评论模板或自动合并服务。
