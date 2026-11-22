# v2 代码与文档复核

原审查基线：`a48901a084c0014e969a3934db8b5250c621cd3b`。下面保留当时发现的问题与反例；原审查的138项测试通过，但未覆盖这些反例。

## 2026-11-23 治理结果

| ID  | 状态   | 处理与证据                                                                                                                                                                                                    |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | 已治理 | [ACP 适配器](../src/acp-connector.ts) 比较验证前后候选文件的路径和内容。变化时明确 publication=none，保留实际退出码、诊断与当前成果，不恢复文件、不重跑命令。改写/新增/删除回归及无 GitHub 写入的本地闭环通过 |
| C02 | 已治理 | [文件收集](../src/runtime-workspace.ts) 保留 UTF-8 BOM；BOM/中文内容字节往返，以及签名任务→ACP→验证→outcome→GitHub blob 编码回归通过                                                                          |
| D01 | 已治理 | [能力台账](capabilities.md) 区分默认评论触发与显式开启的 Issue/PR/push 事件                                                                                                                                   |
| D02 | 已治理 | 能力台账 S02 与当前读取、评论和每次 Git Data/PR 写入前重新授权行为一致                                                                                                                                        |
| D03 | 已治理 | [实现地图](implementation-map.md) 模块表恢复为两列；本轮检查 Markdown 表格列数与本地链接                                                                                                                      |

本轮先运行新增6项测试并确认全部失败，再修正实现并确认全部通过；完整 `npm test` 为 **144通过、0失败**（Windows Node 24.18.0）。类型检查、构建和格式检查通过，独立复核未发现新增问题。新增测试使用实际 Git、HTTP/SQLite、ACP SDK 子进程与 GitHub API 替身；未调用真实模型、未变更生产或创建真实 PR。本轮未重跑 Docker 冒烟。

## 原审查发现

| ID  | 优先级 | 位置                                                                                                                                                                                                                           | 问题与影响                                                                                               | 修正建议                                                     |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C01 | P2     | [acp-connector.ts:214](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/src/acp-connector.ts#L214)、[247](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/src/acp-connector.ts#L247)              | 先验证，再收集发布文件，未绑定验证前后快照。验证命令检查 A 后改成 B 并退出0，PR 包含 B，同时附带通过报告 | 固定候选快照；验证后检查发布输入未变，或重新验证新的候选内容 |
| C02 | P2     | [runtime-workspace.ts:234](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/src/runtime-workspace.ts#L234)                                                                                                       | TextDecoder 默认移除 UTF-8 BOM，导致发布内容不同于工作区字节，可能改变 BOM 依赖文件的行为                | 设置 ignoreBOM:true 等方式保留 BOM，增加字节往返回归         |
| D01 | P2     | [capabilities.md:35](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/capabilities.md#L35)                                                                                                                  | 仍声称除了评论外其他事件不会创建任务，与已实现的 opt-in issues/PR/push 及同页表格矛盾                    | 明确这是未配置 events 时的默认行为                           |
| D02 | P2     | [capabilities.md:73](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/capabilities.md#L73)                                                                                                                  | S02 仍称写仓重新授权属于未来工作，实际上发布器每次 Git Data/PR mutation 都重新授权                       | 改为当前实现，并引用发布器失权回归                           |
| D03 | P3     | [implementation-map.md:19](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/implementation-map.md#L19)、[28](https://github.com/xallor-ai/github-agent-channel/blob/a48901a/docs/implementation-map.md#L28) | tool/result/execution 的未转义竖线将表格拆成4列，但表头只有2列，无法正确渲染模块表                       | 改用顿号或转义竖线；格式化和链接检查不能代替表格结构检查     |

## 修正前的代码反例

**C01 已用临时 Git 工作区和合成 ACP peer 复现。** 验证命令断言 `file.txt` 为 `after\n`，输出 `verified after`，再写成 `NEVER VERIFIED\n` 并退出0。实际返回的 PR proposal 包含后者，同时 test_report/PR body 包含通过状态。无需并发进程；构建或测试中更新跟踪文件也可能触发。

**C02 编码反例：** UTF-8 输入 `ef bb bf 61` 经当前解码和重新编码变为 `61`。发布器将缺少 BOM 的字符串编码成 Git blob；它不是用户指定的内容修改，也不是显式拒绝。

这些修正前复现未调用真实模型、未写真实 GitHub。其对应问题已按上方治理表关闭；原始证据用于解释回归覆盖。

## 不应夸大的结论与已知边界

| 项目         | 事实与判断                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发布中途失权 | 本地 fake transport 复现 blob/tree/commit/ref 已成功后、PR 创建前失权：worker 记 failed，可能留下任务分支但无中间 receipt。属于中间操作恢复缺口；没有证据表明自动重放或 PR 发送结果不明。是否需要 partial 状态/操作日志应单独确定 |
| 真实环境     | 本轮仍未完成真实 harness→代码→GitHub PR 的线上验收                                                                                                                                                                                |
| 原生 ACP     | 非 OS sandbox、工作区需管理员准备、无自动恢复和共享工作区支持，文档已说明；不单独据此认定新缺陷                                                                                                                                   |
| 默认分支读取 | OpenClaw read_file 未使用 push SHA/PR head，能力台账 R08 已说明，不作为本轮新缺陷                                                                                                                                                 |

## 原审查检查范围

- 三个独立分工复核任务/状态、Runtime/工作区、GitHub 发布/部署；同时核对当前文档。
- 完整测试138/138通过；额外本地 HTTP 检查确认授权期间租约过期阻止执行、读取期间过期不返回内容。
- 已有 fsmonitor/环境泄漏、索引模式、带点仓库对账的修正和回归仍存在。
- 未发现新的可复现授权绕过或自动副作用重放；这仅描述本轮检查结果，不构成完整安全证明。
