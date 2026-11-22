# v2 代码与文档复核

审查基线：`a48901a084c0014e969a3934db8b5250c621cd3b`。以下问题**尚未修复**；本轮未修改运行代码或生产环境。重新执行完整套件：Windows Node 24.18.0，138 项通过、0 失败。测试全绿不能覆盖新增反例。

## 已确认的问题

| ID  | 优先级 | 位置                                                                                                                                                                                                                           | 问题与影响                                                                                               | 修正建议                                                     |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C01 | P2     | [acp-connector.ts:214](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/src/acp-connector.ts#L214)、[247](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/src/acp-connector.ts#L247)              | 先验证，再收集发布文件，未绑定验证前后快照。验证命令检查 A 后改成 B 并退出0，PR 包含 B，同时附带通过报告 | 固定候选快照；验证后检查发布输入未变，或重新验证新的候选内容 |
| C02 | P2     | [runtime-workspace.ts:234](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/src/runtime-workspace.ts#L234)                                                                                                       | TextDecoder 默认移除 UTF-8 BOM，导致发布内容不同于工作区字节，可能改变 BOM 依赖文件的行为                | 设置 ignoreBOM:true 等方式保留 BOM，增加字节往返回归         |
| D01 | P2     | [capabilities.md:35](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/capabilities.md#L35)                                                                                                                  | 仍声称除了评论外其他事件不会创建任务，与已实现的 opt-in issues/PR/push 及同页表格矛盾                    | 明确这是未配置 events 时的默认行为                           |
| D02 | P2     | [capabilities.md:73](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/capabilities.md#L73)                                                                                                                  | S02 仍称写仓重新授权属于未来工作，实际上发布器每次 Git Data/PR mutation 都重新授权                       | 改为当前实现，并引用发布器失权回归                           |
| D03 | P3     | [implementation-map.md:19](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/implementation-map.md#L19)、[28](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/implementation-map.md#L28) | tool/result/execution 的未转义竖线将表格拆成4列，但表头只有2列，无法正确渲染模块表                       | 改用顿号或转义竖线；格式化和链接检查不能代替表格结构检查     |

## 代码反例

**C01 已用临时 Git 工作区和合成 ACP peer 复现。** 验证命令断言 `file.txt` 为 `after\n`，输出 `verified after`，再写成 `NEVER VERIFIED\n` 并退出0。实际返回的 PR proposal 包含后者，同时 test_report/PR body 包含通过状态。无需并发进程；构建或测试中更新跟踪文件也可能触发。

**C02 编码反例：** UTF-8 输入 `ef bb bf 61` 经当前解码和重新编码变为 `61`。发布器将缺少 BOM 的字符串编码成 Git blob；它不是用户指定的内容修改，也不是显式拒绝。

这些复现未调用真实模型、未写真实 GitHub。建议先修 C01/C02，再修正文档，并补针对性回归。

## 不应夸大的结论与已知边界

| 项目         | 事实与判断                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发布中途失权 | 本地 fake transport 复现 blob/tree/commit/ref 已成功后、PR 创建前失权：worker 记 failed，可能留下任务分支但无中间 receipt。属于中间操作恢复缺口；没有证据表明自动重放或 PR 发送结果不明。是否需要 partial 状态/操作日志应单独确定 |
| 真实环境     | 本轮仍未完成真实 harness→代码→GitHub PR 的线上验收                                                                                                                                                                                |
| 原生 ACP     | 非 OS sandbox、工作区需管理员准备、无自动恢复和共享工作区支持，文档已说明；不单独据此认定新缺陷                                                                                                                                   |
| 默认分支读取 | OpenClaw read_file 未使用 push SHA/PR head，能力台账 R08 已说明，不作为本轮新缺陷                                                                                                                                                 |

## 检查范围

- 三个独立分工复核任务/状态、Runtime/工作区、GitHub 发布/部署；同时核对当前文档。
- 完整测试138/138通过；额外本地 HTTP 检查确认授权期间租约过期阻止执行、读取期间过期不返回内容。
- 已有 fsmonitor/环境泄漏、索引模式、带点仓库对账的修正和回归仍存在。
- 未发现新的可复现授权绕过或自动副作用重放；这仅描述本轮检查结果，不构成完整安全证明。
