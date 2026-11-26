# Channel v2：配置、任务与发布契约

状态：当前实现。旧版默认 Runtime、根级评论字段、扁平文本结果、v1 路由和数据库自动迁移已删除。

## 必须显式配置

Bridge 的 `runtime.type` 必须是 `openclaw` 或 `acp`。分别按 [OpenClaw](setup.md) 或 [ACP](acp-setup.md) 配置；未知类型、缺少类型或混用配置字段都会失败。

按[自助接入指南](agent-self-service.md)配对设备，并从本机显式提交一个仓库的声明。服务端从设备凭据解析 GitHub 配置者，复查安装范围和仓库 admin 权限，绑定修订随实际变化递增。见[绑定生命周期](binding-lifecycle.md)。

云端 `connector` 仅配置 `timeoutMs`。PR 写入默认关闭；若另需创建 draft PR，由服务端管理员为可信安装和仓库 ID 添加可选策略（不启用仓库或任何事件）：

```yaml
writeProfiles:
  - installationId: 123456
    repositoryId: 987654
    policy:
      baseBranch: main
      allowedPaths: [src/, tests/, README.md]
      maxFiles: 20
      maxBytes: 262144
```

仓库声明可以省略 `events`。默认关注 Channel 支持、GitHub 实际投递且通过签名、身份、安装及仓库检查的事件；指定列表只缩小范围。App 漏订阅不等于仓库没有活动。普通人类评论仅更新上下文，机器人自己的评论记为回执，其他机器人的事件忽略。开放线程的新评论或新建 Issue 明确提及机器人时才开工。可选 `autoTriage` 处理新 Issue，`triggerLabel` 处理匹配标签，`autoReview` 处理 PR opened/synchronize；其他标签、关闭事件和非删除分支 push 默认只记录。关闭事件不能启动任务，push 也不会重复启动相同 head 的评审。

评论/读取需要 Metadata/Contents Read、Issues/Pull requests Write；PR 发布还需 GitHub App **Contents Read and write**，组织安装方批准新增权限。没有匹配的 writeProfiles 则禁止 PR 发布；设备无权自行扩大服务端写策略。普通只读调用仍申请只读 contents token。

仓库管理员分别选择 `deepReview` 和 `nativeReview`，有效权限取绑定授权与负责适配器声明能力的交集。OpenClaw 支持这两种读取/发布能力，ACP 不支持。没有授权时不能借此发原生 Review 或写入 Git。参见[评审指南](pr-review.md)。

allowedPaths 支持精确文件和以 `/` 或 `/**` 结尾的目录前缀；不是通用 glob。拒绝 `.git`、workflow、路径越界、重复/大小写冲突、symlink/submodule 及不支持的文件模式。文件变更总上限 100 个/512 KiB；policy 可设更低限制。

## 网络协议

公开路径为 Webhook 和 `/connector/v2/`。必须重新渲染或更新 HTTPS edge 的 v2 路由；v1 不提供别名或重定向。

| 请求                                      | 数据/返回                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /webhooks/github`                   | 验签后持久化：关联任务返回 202；仅观察返回 200 及 observed、reason、taskId:null、duplicate；忽略返回 200 及 ignored                                          |
| `POST /connector/v2/devices/pair` | GitHub 用户 Bearer 和一次性邀请、设备令牌；返回设备 ID 和 GitHub 数字 ID |
| `POST /connector/v2/bindings/read` | 设备 Bearer；指定 owner/repo，返回此设备的登记记录或 null |
| `POST /connector/v2/bindings/apply` | 设备 Bearer；提交指定仓库、expectedRevision、declaration，返回生效记录 |
| `POST /connector/v2/activities` | 设备 Bearer；提交 owner、repo、runtime、after、limit；按游标返回当前绑定保留的活动及 nextCursor、hasMore、truncated。 |
| `POST /connector/v2/activities/received` | 负责人的接收端落盘后，按当前 owner、repo、runtime、bindingId 提交 1–25 对有序的 cursor 与 deliveryId。200 逐条确认；410 列出已过期项，整批不写，可另送未过期项。租约、心跳、请求分页都不构成送达确认。 |
| `POST /connector/v2/claim`                | 设备 Bearer，提交 `{runtime:{type,id,deepReview,nativeReview}}`；只领取匹配当前设备、负责适配器及身份的任务；204 或 `{task,leaseToken,expiresAt}`                         |
| `POST /connector/v2/tasks/<id>/execution` | `{leaseToken,event:{kind:"started",provider,runId}}`；只记录当前 assignment 的运行标识 |
| `POST /connector/v2/tasks/<id>/source-grant` | 有效设备及租约、已启用的深评绑定和固定同仓 PR；仅连接器下载进程使用单仓只读短期凭据，不能作为模型工具调用。 |
| `POST /connector/v2/tasks/<id>/tool`      | `{leaseToken,name,args}`；按 target/租约授权；PR 可用 read_pull_diff；review_access 为连接器快照访问核验，不能指定任意仓库或 SHA                      |
| `POST /connector/v2/tasks/<id>/result`    | `{leaseToken,status:"succeeded",outcome}` 或 `{leaseToken,status:"failed"或"unknown"}` |
| `GET /tasks/<id>/conversation` | 管理员按根任务或任一续办执行查看有界轮次、执行及发布状态和原线程回执；不附原评论正文。 |
| `POST /tasks/<id>/reconcile-clarification` | 管理员对结果未知的问题做只读 GitHub 对账。唯一的同 Bot、原线程、精确正文与提交版本、可信评论 ID/创建时间才允许打开等待状态；不重发。 |

管理接口 `POST /admin/device-invites` 和 `POST /admin/device-revoke` 仅供受控管理入口使用，不经公网代理。所有任务的 target/source 必填。Issue/PR 的号码在 target.number，仓库目标可以携带 ref/sha；ACP 对明确的 target.sha 校验工作区 HEAD，不匹配时拒绝启动，不自动切分支；评论 ID 只在原始 source.commentId。PR 的 target.revision 保存 baseSha、headSha、baseRepoId 和 headRepoId；评论任务在授权领取时固定版本后再交付。安装、仓库和 actor 来自服务端，不允许 Runtime 提交替换字段。

对已收到的关闭事件，服务端按仓库和线程持久保留 GitHub 的 `closed_at`。评论和 opened 委派使用签名负载的 `created_at`，标签和 synchronize 使用目标的 `updated_at`；不以 Webhook 到达时间推断先后。只有能证明晚于关闭、且目标当时开放的行动才可继续；时间相同、缺失或无效时保守阻断。已知关闭后，同一 base/head 的新自动评审不会复用关闭前的旧任务。领取上下文只取该任务首次投递游标之前的活动，不含随后排队的委派。

领取任务时服务端复查发起人权限；assignment 的 `reviewPolicy` 表示实际可用授权，`threadContext` 包含同一绑定同一线程最多八条近期活动摘要。活动文本均是不可信背景，不会自行触发模型。活动接口独立于执行队列，使用同一设备身份和有效绑定核验，单页上限 100；每仓最多保留 1,024 条、7 天的活动，每条摘要最多 1,024 个 UTF-16 码元。离线后用上页 nextCursor 续读；truncated 表示游标之后有记录超出保留窗口，不能声称完整回放。

成功 outcome 必须包含 text、artifacts 数组、publication 对象。publication 为 comment、clarification（经核验的普通问题评论）、review（固定版本 PR 的 COMMENT 总评）、none 或带 baseBranch/baseSha/files 的 pull_request。支持 text、link、test_report、change_set 产物。结果有界并严格拒绝额外字段；相同 canonical outcome 重传仅确认，内容不同返回409。HTTPS edge 支持2MB结果正文，实际结果 schema 有更细的限制。

publication=none 保存成果并将 deliveryStatus 置 skipped；comment/clarification/review/pull_request 则进入独立发布阶段，成功记录 publicationReceipt。status=succeeded 仅证明执行结果已保存，不能代替发布成功。模型文字不能替代实际 diff 或测试退出码。

## 使用新状态库

云端任务、活动与绑定与逐事件收件确认共享 schema 7；设备身份另库持久化，内网执行 journal 为 schema 3，活动收件箱为 schema 2。协议路径仍是 v2，须使用同一修订的服务端和 bridge。旧格式直接抛出 StorageSchemaError；没有迁移、修复或清空行为。

1. 对已有旧部署，先停止接收新任务，完成现有任务与 unknown 对账，再停止旧 bridge 和服务端。
2. 保留旧配置和数据库备份。准备新的 dataFile/stateFile；容器使用新的 projectName/数据卷。不要把旧库挂进 v2，也不要在尚有任务运行时删除旧卷。
3. 使用 v2 配置、镜像和 edge 路由启动服务端，再启动选定 Runtime bridge。复用卷前分别核对数据库 schema；协议版本相同不代表任务库格式相同。
4. 先跑对应 Runtime 探针，再新建明确测试任务。旧任务不会自动导入或重放。

## Issue → 代码 → PR 验收

1. 运行者准备对应仓库的干净独立 clone，安装并认证 ACP harness；配置仓库数字 ID→工作区、verification 和 runtime.publication。
2. 管理员为目标仓库配置 writeProfiles，App Contents 写权限已获安装方批准，目标 baseBranch 与工作区 HEAD 一致。
3. 用有写权限的账号在绑定 Issue 中 @App 提交可判定的小型修复要求，或使用已启用的 Issue 标签触发。
4. 核对 source/target、Runtime 标识、实际 change_set、验证命令及退出码。配置验证失败/超时时 ACP 不生成 PR publication。验证前后候选文件的路径或内容发生变化时，即使命令退出0也禁止发布；保留当前成果和诊断，不自动恢复或重跑验证。
5. 发布器重查权限、远端基线与路径，再创建派生分支和 draft PR；核对 publicationReceipt.url 及 PR 的实际文件和 commit。
6. 若写入返回结果不明，先对账可能残留的分支/commit/PR；保持 unknown，不盲目重新发任务。

本篇描述实现契约；具体真实验收证据见[验证记录](runtime-neutral-validation-20261122.md)，不以本地测试替代真实项目验收。

**关闭与观察过滤。** 已验证且绑定有效的 Issue/PR 关闭，即使由 Bot 触发或不在用户观察过滤内，仍封锁旧任务；仅用于封锁的消息不进活动页、不公开原文、不产生任务。同版本投递被合并后才收到更早关闭时，仅对可证实未派发且含新生命周期事件的队列项恢复决定，使用原事件时间、发起人及最初队列期限。前序执行已派发/状态不明时，管理员查询原投递的 reviewFollowUp，核对后再决定是否重新委派。

同一 head 的更新先于属于上一生命周期的旧更新到达，随后才收到关闭时，早于或不能证实晚于关闭的重复投递不得继续关联到新任务；新任务本身仍按其来源时间核验。
