# 让 Agent 评审一个 PR

在已配对设备的仓库声明中启用 `pull_request.opened` 和 `pull_request.synchronize`，或在开放 PR 会话中按该绑定的规则发起评论任务。GitHub App 必须有该仓库的访问权限，发起人须有 write、maintain 或 admin 权限。使用同一修订的服务端和 bridge，准备新的云任务库（schema 8）与本地 journal（schema 3）；切换步骤见[协议说明](protocol-v2.md)。旧库不会迁移。

| 想得到什么 | 配置 | 能核对什么 |
| --- | --- | --- |
| PR 改动分析 | OpenClaw 默认路径；无需手贴 diff | 任务固定的仓库、PR、base/head、已提供与缺失的补丁；默认发布普通会话评论 |
| 查未改动的调用方或测试 | 仓库绑定选择 `deepReview: true`，负责 Agent 支持深评 | 模型可从 head 搜索路径/行号并打开源码。实际引用才能证明检查过；搜索工具可用不等于已通读 |
| GitHub 原生 Review | 仓库绑定选择 `nativeReview: true`，负责 Agent 支持原生 Review | GitHub COMMENT 总评的 ID、URL 及 commit_id；不会自动批准、请求修改或合并 |

**版本和范围。** 签名 opened/synchronize 事件各自保留 base/head SHA 和仓库数字 ID；会话评论没有这两个 SHA，在首次授权领取时解析并固定。当目标不是同一开放 PR、任一版本已变、fork 超出绑定或授权失效，不能用当前最新版本代替原任务。普通 Issue 和 push 不是这条 PR 路径。差异请求使用 [GitHub Compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits)，参数为固定的 `baseSha...headSha`。GitHub 只在第一页返回文件（最多 300 个），随后再次核实 PR 版本与授权。Channel 最多提供 100 项、文件条目总计约 64 KiB，每个 patch 至多 12 Ki 字符；上游响应超过 4 MiB 时不传递任何补丁，并明确标记缺失。仅有文件状态、删除或改名信息不代表取得了完整 diff；检查返回的 limitations、patchStatus 与文件总数。

**启用自动评审。** 配对后按[自助接入指南](agent-self-service.md)绑定。下例观察默认事件，另外允许为 PR 打开/更新执行深评并发布正文型原生 Review。CLI 自动读取修订；状态显示负责 Agent、请求与生效能力。无需改 ECS 或再开启一组 Runtime 开关。

```yaml
owner: xallor-ai
repo: xallor
declaration:
  enabled: true
  autoReview: true
  deepReview: true
  nativeReview: true
```

**源码由谁同步。** 首次深评时，配对连接器在本机准备专用 bare Git 对象库，通过 HTTPS 从 GitHub 获取任务指定的 head。再次评审只补缺少的对象；缓存命中仍需有效租约、绑定和授权。无需填写仓库路径或在 OpenClaw 工作目录执行 git pull。普通差异分析不下载整仓，普通 push 不是自动同步任务。

私有仓库使用 App 的单仓短期只读 installation token。连接器为一次获取单独请求凭据，服务端核验设备、租约、绑定、发起人权限和当前 PR；App 私钥留在服务端，下载凭据不作为模型工具结果。GitHub 凭据能读授权仓库而非只读单个 SHA；只向信任的执行设备启用深评。按固定 SHA 读取是连接器的约束。停用绑定后，Channel 拒绝新凭据、后续模型读取和发布，不能远程收回已取得的源码。已签发的 GitHub 单仓只读令牌独立于 Channel 租约；仅在令牌到期（通常一小时）或 GitHub 撤销后失效。关闭任务不会即时撤销 GitHub 凭据，下载期间需信任设备。缓存目录须仅桥接进程可写，模型与 harness 不挂载该目录。缓存位于本地 journal 同级的 review-cache（容器内 /data/review-cache）。桥接进程使用专用私有目录；Windows 由管理员设置 ACL。缓存含 staging 的逻辑上限为 1 GiB / 50,000 个条目，下载中抽查用量；严格物理上限请用文件系统配额。只有确认不再有 Git 下载时才回收准备目录。下载进程树退出无法确认或下载时崩溃会保留 .fetch-in-flight 隔离标记：仍获准的已有提交可验证后读取，新下载拒绝；不能因锁已释放就删除现场。处理时先停用该桥接进程，确认相关 Git/HTTPS 子进程都已退出，再由管理员清理专用缓存或解除标记。不会自动删已发布对象。复制/提升增量对象时按条目检查取消，已提交的操作仍可能在途。

OpenClaw 的 `search_repo` 接收字面量查询并返回匹配路径、行号及片段；`read_file` 打开任务版本中的路径。bare 搜索每次最多检查 4,096 个文件、8 MiB，单文件最多 1 MiB；最多返回 50 项，每个片段最多 400 字符，读取最多返回 64 Ki 字符。检查 `truncated`；没有匹配不等于整个仓库没有该符号。快照的本地读取须先通过 `review_access` 检查租约、绑定、actor 和版本；云端的 `read_pull_diff` 和下载凭据请求 不接受模型自选仓库或提交。ACP 的编码工作区不提供这些 OpenClaw 选项；处理 PR 时要求预备干净 clone 的 HEAD 匹配固定 head，且双方仓库 ID 与绑定一致。

PR 的单文件补读从固定提交逐层遍历 Git 树（最多 24 段），只接受不超过 128 KiB 的普通 UTF-8 blob，并验证 Git 对象哈希。符号链接、目录和截断的树不会被当作文件证据。

**超时。** 冷启动包含一次 Git 下载。执行机需能通过 HTTPS 访问 GitHub；请为模型处理和冷启动共同留出运行及领取时间。取不到指定提交、下载超时或超出配额时，不能切换为默认分支继续。

**核验交付。** 查询原任务的 `target.revision`、`outcome.publication.kind`、`deliveryStatus`、`publicationReceipt`。普通评论是 W1；只有在 GitHub 打开对应 `#pullrequestreview-N` 且 commit_id 等于目标 head 的 COMMENTED Review 才有原生总评证据。发布器发起写入前复核权限、开放状态和双方版本，并传入固定 commit_id；GitHub 不提供锁住 base/head 的原子写入。行内意见尚不支持：不能把正文里的文件或行号当成已验证的行内评论。响应丢失按[对账流程](operations.md)处理，不自动重发。

目前仓库内的 HTTP、SQLite、Git 对象和 Octokit 测试可以证明对应代码行为，不能证明已经在真实仓库用新版本完成评审。真实验收按[H1/H2 清单](superpowers/plans/2026-11-25-pr-review-context.md)：保留 delivery/task/run、版本、模型实际引用、覆盖遗漏与 GitHub 回执；对照该提交核查每一项。此前真实评论与 ACP 编码结果见[能力台账](capabilities.md)，不计入原生 Review 或深评验收。

**真实只读探针（2026-11-25）：** 对公开的 [PR #19](https://github.com/xallor-ai/github-agent-channel/pull/19)，通过 GitHub API 读取固定 base `1e56df7` / head `45b848d` 的差异（16/16 文件）；3.183 的真实 OpenClaw 收到适配器自动提供的材料，返回 `src/runtime-failure.ts` 中的一行新增代码，与实际 patch 逐字核对通过。探针 `e297022a-057f-43b0-8822-431f6ee3575d` 未写 GitHub，未使用生产任务队列；不计作原生 Review、深评或 H1/H2 真实闭环。

同一公开 PR 的深评探针 `ec8c8acb-7373-4671-9d5f-34ea123e38a6` 使用 3.183 真实 OpenClaw 和只读 bare Git 对象库。没有在提示里提供文件名；模型搜索两次、打开一个文件，找到本版未改动的 `tests/github-publication.test.ts`，引用源码与固定 head 的 blob 一致。其中一次搜索达到结果上限，已在输出中标记。本探针使用隔离的工具授权回执，没有验证生产绑定、Webhook 收件或外部发布。

**自动评审的材料门槛（#24）。** opened/synchronize 没有取得任何可用固定版本 patch 时，连接器不调用模型，不以正文代替差异；记录 `review_diff_unavailable`，在仍获授权的开放 PR 发布带 base/head 的未完成通知。若确认比较为空，单列“没有变更文件”，不宣称 CI 通过。仍有部分补丁时，列出材料覆盖；评论提问可使用其他线程材料，不能以此证明已审查代码。上线后仍须真实 H1/H2 验收。

若完整材料可核实仅有空行增删，记录实际观察并发普通说明，不误报补丁缺失，不判断语义无影响。截断末尾的孤立标记并非已确认的空行。

**连续推送时如何查评审。** 管理员从 `GET /activities/<deliveryId>` 找到任务，再查 `GET /tasks/<taskId>/review-lineage`。它不启动评审，也不重新发布。

| 返回项 | 能据此判断什么 |
| --- | --- |
| `reviewLineage` | 旧任务的固定版本与授权读取同一开放 PR 时实际看见的新版本；签名事件能唯一对应时还有接替任务。若无唯一对应，保留原因与已知版本，不能凭最新到达的 Webhook 猜测。签名事件证明同一 SHA 是新一轮时，轮次依据与 GitHub 读取依据分开。 |
| `reviewInput` | 服务端为本次任务准备的首份固定比较摘要：变更文件数、实际提供数、补丁完整/截断/不可用数及是否有限制。不保存路径或源码；不证明模型收到、审完或同意合并。 |
| `previousPublishedReview` | 能核验且可唯一排序的上一轮已发布结果、对应版本与输入摘要。只作历史参照。每个新版本仍独立获取相对本轮 base 的变更；空提交、内容相同的新提交或改写历史都不继承旧 CI、审批或 Review。 |

例：旧任务正在审 H1，GitHub 已变到 H3；可以同时看到“H1 执行已返回”和“H1 未发布”。不能把“结果过期”说成“已停止运行”。H3 是否完成，请看 H3 自己的执行状态和发布回执。

同一范围内能唯一确定上一份已发布评审时，OpenClaw 会收到该版本、回执 ID 和最多 2,048 字符的历史意见，截断会标明。模型应对照**当前**固定差异复核仍相关的意见；这段文字只是背景，不是新指令，也不是证明已解决。若原任务、签名更新时间或生命周期无法唯一对应，则不提供历史意见。

对先改成 B、再回到 A 的 PR，最终 SHA 相等不代表两个 A 是同一轮。Channel 在领取和发布前检查已收到的签名变更，即使 GitHub 此刻又返回 A，也不会给已知过时的 A 结果放行。乱序事件补齐后可从原委派恢复可唯一确定且仍在期限内的新轮次；时间相同、证据不足时宁可标明归属不明。若变化尚未投递、也从未在授权查询中被观察到，Channel 无法证明它发生过；GitHub 不提供将检查与 POST 锁为一个原子操作的能力。
适配器声明可提供的能力；管理员只在仓库绑定选择增强。PR 领取响应显式携带本仓有效的深评和原生 Review 策略，非 PR 不携带该策略，其他绑定仍可普通分析回帖；外部写入前重新授权。模型首次派发前读取材料的传输中断可确认为未派发（preparation_interrupted），不阻止设备领取下一任务；首次派发之后失联仍需对账，不自动重跑。
