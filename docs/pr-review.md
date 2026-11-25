# 让 Agent 评审一个 PR

在已配对设备的仓库声明中启用 `pull_request.opened` 和 `pull_request.synchronize`，或在开放 PR 会话中按该绑定的规则发起评论任务。GitHub App 必须有该仓库的访问权限，发起人须有 write、maintain 或 admin 权限。使用同一修订的服务端和 bridge，准备新的云任务库（schema 4）与本地 journal（schema 3）；切换步骤见[协议说明](protocol-v2.md)。旧库不会迁移。

| 想得到什么 | 配置 | 能核对什么 |
| --- | --- | --- |
| PR 改动分析 | OpenClaw 默认路径；无需手贴 diff | 任务固定的仓库、PR、base/head、已提供与缺失的补丁；默认发布普通会话评论 |
| 查未改动的调用方或测试 | 仓库绑定和 OpenClaw runtime 均设置 `deepReview: true` | 模型可从 head 搜索路径/行号并打开源码。实际引用才能证明检查过；搜索工具可用不等于已通读 |
| GitHub 原生 Review | OpenClaw 设置 `runtime.publishReview: true`，配对的仓库管理员在该仓库绑定中设置 `nativeReview: true` | GitHub COMMENT 总评的 ID、URL 及 commit_id；不会自动批准、请求修改或合并 |

**版本和范围。** 签名 opened/synchronize 事件各自保留 base/head SHA 和仓库数字 ID；会话评论没有这两个 SHA，在首次授权领取时解析并固定。当目标不是同一开放 PR、任一版本已变、fork 超出绑定或授权失效，不能用当前最新版本代替原任务。普通 Issue 和 push 不是这条 PR 路径。差异请求使用 [GitHub Compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits)，参数为固定的 `baseSha...headSha`。GitHub 只在第一页返回文件（最多 300 个），随后再次核实 PR 版本与授权。Channel 最多提供 100 项、文件条目总计约 64 KiB，每个 patch 至多 12 Ki 字符；上游响应超过 4 MiB 时不传递任何补丁，并明确标记缺失。仅有文件状态、删除或改名信息不代表取得了完整 diff；检查返回的 limitations、patchStatus 与文件总数。

**启用仓库。** 在[仓库声明](agent-self-service.md)中显式设置需要的能力。先用 `agent repo status` 获取实际修订，保留原有事件和规则，更新 `expectedRevision` 后 `agent repo apply`。下例只订阅 PR 打开与更新；两个布尔字段均默认关闭。服务端校验配对用户的仓库 admin 权限并记录绑定修订；无需编辑 ECS 配置或为 Review 设置 draft PR 的 writeProfiles。

```yaml
declaration:
  enabled: true
  events: [pull_request.opened, pull_request.synchronize]
  deepReview: true
  nativeReview: true
```

**选择深评。** 在现有 agent.yaml 的 OpenClaw runtime 中增加所需字段（保留其他必填配置）：

```yaml
runtime:
  type: openclaw
  # 在既有 baseUrl、agentId、认证与超时字段后添加：
  deepReview: true
  # 可选：独立于深评，申请将结果发布为原生 Review
  publishReview: true
```

没有本地源码时，bridge 可经已授权的 `read_snapshot` 接口取得当前 head 的完整文本树；只接受最多 128 个普通 UTF-8 文件、每文件最多 128 KiB、序列化快照不超过 1,000,000 字节。GitHub 树截断、二进制、符号链接、子模块、不支持的路径或超限均无法作为完整快照；云端读取对象还受 90 秒、总计 3,000,000 字节、单次响应 512,000 字节限制；最多同时读取 4 个 blob。大仓库可预备对象库。快照不可用时，深评请求失败。若只需要差异分析，请明确调整配置并发起新任务。

对于超出该范围的仓库，管理员可以自行在 bridge 可读的专用位置准备 bare Git 仓库，设置正确的 `https://github.com/OWNER/REPO.git` origin，并在事件发生前或领取前准备好对应 head 对象。在现有 runtime 中添加：

```yaml
  reviewRepositories:
    "987654": /srv/channel/review/my-repo.git
```

映射键是仓库数字 ID。使用真实的绝对目录；不用 ACP 的可写工作区，不配置 alternates、部分克隆或重定向元数据。连接器不会 fetch 或 checkout，不把仓库路径、Token 或 Git 命令交给模型。容器中的路径须由管理员提供、只读挂载，并有可用的 Git。每个任务只读取固定 commit 树中的普通 blob；读取结束清理内存，不创建需要重启回收的检出目录。管理员维护的 bare 仓库在任务结束后保留。

OpenClaw 的 `search_repo` 接收字面量查询并返回匹配路径、行号及片段；`read_file` 打开任务版本中的路径。bare 搜索每次最多检查 4,096 个文件、8 MiB，单文件最多 1 MiB；最多返回 50 项，每个片段最多 400 字符，读取最多返回 64 Ki 字符。检查 `truncated`；没有匹配不等于整个仓库没有该符号。快照的本地读取须先通过 `review_access` 检查租约、绑定、actor 和版本；云端的 `read_pull_diff`、`read_snapshot` 不接受模型自选仓库或提交。ACP 的编码工作区不提供这些 OpenClaw 选项；处理 PR 时要求预备干净 clone 的 HEAD 匹配固定 head，且双方仓库 ID 与绑定一致。

PR 的单文件补读从固定提交逐层遍历 Git 树（最多 24 段），只接受不超过 128 KiB 的普通 UTF-8 blob，并验证 Git 对象哈希。符号链接、目录和截断的树不会被当作文件证据。

**超时。** 自动准备快照的 Git 对象请求总预算为 90 秒，另有授权检查。启用深评的 bridge 建议设置顶层 `requestTimeoutMs: 120000`，Runtime 超时和云端领取期限应再留出模型与发布余量。重新渲染的 Nginx 连接器路由读取超时为 150 秒；已有代理需同步检查。

**核验交付。** 查询原任务的 `target.revision`、`outcome.publication.kind`、`deliveryStatus`、`publicationReceipt`。普通评论是 W1；只有在 GitHub 打开对应 `#pullrequestreview-N` 且 commit_id 等于目标 head 的 COMMENTED Review 才有原生总评证据。发布器发起写入前复核权限、开放状态和双方版本，并传入固定 commit_id；GitHub 不提供锁住 base/head 的原子写入。行内意见尚不支持：不能把正文里的文件或行号当成已验证的行内评论。响应丢失按[对账流程](operations.md)处理，不自动重发。

目前仓库内的 HTTP、SQLite、Git 对象和 Octokit 测试可以证明对应代码行为，不能证明已经在真实仓库用新版本完成评审。真实验收按[H1/H2 清单](superpowers/plans/2026-11-25-pr-review-context.md)：保留 delivery/task/run、版本、模型实际引用、覆盖遗漏与 GitHub 回执；对照该提交核查每一项。此前真实评论与 ACP 编码结果见[能力台账](capabilities.md)，不计入原生 Review 或深评验收。

**真实只读探针（2026-11-25）：** 对公开的 [PR #19](https://github.com/xallor-ai/github-agent-channel/pull/19)，通过 GitHub API 读取固定 base `1e56df7` / head `45b848d` 的差异（16/16 文件）；3.183 的真实 OpenClaw 收到适配器自动提供的材料，返回 `src/runtime-failure.ts` 中的一行新增代码，与实际 patch 逐字核对通过。探针 `e297022a-057f-43b0-8822-431f6ee3575d` 未写 GitHub，未使用生产任务队列；不计作原生 Review、深评或 H1/H2 真实闭环。
