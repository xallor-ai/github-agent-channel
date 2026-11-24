# Channel v2：配置、任务与发布契约

状态：当前实现。旧版默认 Runtime、根级评论字段、扁平文本结果、v1 路由和数据库自动迁移已删除。

## 必须显式配置

Bridge 的 `runtime.type` 必须是 `openclaw` 或 `acp`。分别按 [OpenClaw](setup.md) 或 [ACP](acp-setup.md) 配置；未知类型、缺少类型或混用配置字段都会失败。

动态登记的目标语义见[绑定生命周期](binding-lifecycle.md)，尚未对外开放。以下为当前配置。

服务端仍配置 GitHub App、bindings 和 connector 身份。下面的 binding 示例显式启用 Issue 场景及 PR 发布；ID、仓库、路径需替换为自己的值：

```yaml
bindings:
  - id: code-repo
    installationId: 123456
    repositoryId: 987654
    owner: YOUR_OWNER
    repo: YOUR_REPO
    enabled: true
    events: [issue_comment.created, issues.opened, issues.labeled]
    triggerLabel: agent
    writePolicy:
      baseBranch: main
      allowedPaths: [src/, tests/, README.md]
      maxFiles: 20
      maxBytes: 262144
```

省略 events 时只接收明确 @App 的 issue_comment.created。默认 issues.opened 也要求提及。在指定 binding 中设置 `requireMention: false` 后，已启用的 issue_comment.created 接受开放线程的人类非空评论，issues.opened 无需提及；不会自动添加 events 或授予写权限。issues.labeled 只接受配置的 triggerLabel。还可显式启用 pull_request.opened、pull_request.synchronize 和非删除分支 push。其他事件不会自动创建任务。

评论/读取需要 Metadata/Contents Read、Issues/Pull requests Write；PR 发布还需 GitHub App **Contents Read and write**，组织安装方批准新增权限。没有 writePolicy 则禁止 PR 发布；App 的写权限不会替代 binding 策略。普通只读调用仍申请只读 contents token。

allowedPaths 支持精确文件和以 `/` 或 `/**` 结尾的目录前缀；不是通用 glob。拒绝 `.git`、workflow、路径越界、重复/大小写冲突、symlink/submodule 及不支持的文件模式。文件变更总上限 100 个/512 KiB；policy 可设更低限制。

## 网络协议

公开路径为 Webhook 和 `/connector/v2/`。必须重新渲染或更新 HTTPS edge 的 v2 路由；v1 不提供别名或重定向。

| 请求                                      | 数据/返回                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /webhooks/github`                   | GitHub 原始签名事件；持久化后 202，忽略为 200                                          |
| `POST /connector/v2/claim`                | connector Bearer，空对象；204 或 `{task,leaseToken,expiresAt}`                         |
| `POST /connector/v2/tasks/<id>/execution` | `{leaseToken,event:{kind:"started",provider,runId}}`；只记录当前 assignment 的运行标识 |
| `POST /connector/v2/tasks/<id>/tool`      | `{leaseToken,name,args}`；当前受控读取工具为 read_issue/read_file                      |
| `POST /connector/v2/tasks/<id>/result`    | `{leaseToken,status:"succeeded",outcome}` 或 `{leaseToken,status:"failed"或"unknown"}` |

所有任务的 target/source 必填。Issue/PR 的号码在 target.number，仓库目标可以携带 ref/sha；ACP 对明确的 target.sha 校验工作区 HEAD，不匹配时拒绝启动，不自动切分支；评论 ID 只在原始 source.commentId。安装、仓库和 actor 来自服务端，不允许 Runtime 提交替换字段。

成功 outcome 必须包含 text、artifacts 数组、publication 对象。publication 为 comment、none 或带 baseBranch/baseSha/files 的 pull_request。支持 text、link、test_report、change_set 产物。结果有界并严格拒绝额外字段；相同 canonical outcome 重传仅确认，内容不同返回409。HTTPS edge 支持2MB结果正文，实际结果 schema 有更细的限制。

publication=none 保存成果并将 deliveryStatus 置 skipped；comment/PR 则进入独立发布阶段，成功记录 publicationReceipt。status=succeeded 仅证明执行结果已保存，不能代替发布成功。模型文字不能替代实际 diff 或测试退出码。

## 使用新状态库

当前云端和 journal 的 schema version 均为2。旧格式直接抛出 StorageSchemaError；没有迁移、修复或清空行为。

1. 对已有旧部署，先停止接收新任务，完成现有任务与 unknown 对账，再停止旧 bridge 和服务端。
2. 保留旧配置和数据库备份。准备新的 dataFile/stateFile；容器使用新的 projectName/数据卷。不要把旧库挂进 v2，也不要在尚有任务运行时删除旧卷。
3. 使用 v2 配置、镜像和 edge 路由启动服务端，再启动选定 Runtime bridge。普通 v2 更新可继续复用 v2 的原卷，旧版不可。
4. 先跑对应 Runtime 探针，再新建明确测试任务。旧任务不会自动导入或重放。

## Issue → 代码 → PR 验收

1. 运行者准备对应仓库的干净独立 clone，安装并认证 ACP harness；配置仓库数字 ID→工作区、verification 和 runtime.publication。
2. 服务端启用 binding.writePolicy，App Contents 写权限已获安装方批准，目标 baseBranch 与工作区 HEAD 一致。
3. 用有写权限的账号在绑定 Issue 中 @App 提交可判定的小型修复要求，或使用已启用的 Issue 标签触发。
4. 核对 source/target、Runtime 标识、实际 change_set、验证命令及退出码。配置验证失败/超时时 ACP 不生成 PR publication。验证前后候选文件的路径或内容发生变化时，即使命令退出0也禁止发布；保留当前成果和诊断，不自动恢复或重跑验证。
5. 发布器重查权限、远端基线与路径，再创建派生分支和 draft PR；核对 publicationReceipt.url 及 PR 的实际文件和 commit。
6. 若写入返回结果不明，先对账可能残留的分支/commit/PR；保持 unknown，不盲目重新发任务。

本篇描述实现契约；具体真实验收证据见[验证记录](runtime-neutral-validation-20261122.md)，不以本地测试替代真实项目验收。
