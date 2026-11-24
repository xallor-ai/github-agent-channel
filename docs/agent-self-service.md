# 从连接器启用仓库

以下命令都使用 Node 24，从 Channel 检出目录运行。管理员负责首次邀请和撤销；配对成功后，仓库管理员在自己的连接器上新增、查询、修改和停用绑定，不必登录 ECS 或开放入站端口。

## 首次配对

1. 在服务端宿主机（或其受控管理入口）上，从可信渠道核对配置者的 GitHub **数字用户 ID**。将服务端管理令牌通过本机秘密管理工具注入环境变量 `CHANNEL_ADMIN_TOKEN`，再执行：

   ```sh
   npm run channel -- admin invite http://127.0.0.1:18896 123456 ./channel-data/secrets/invite.private
   ```

   示例端口为部署的宿主回环映射，请按实际端口调整；公网入口不转发管理接口。每个邀请绑定一个用户，10 分钟内有效、只可消费一次。命令要求输出文件不存在，回显过期时间和文件路径。管理员通过私密渠道把文件交给指定用户，不传管理令牌。文件须保存在用户专用目录，Windows 请限制目录 ACL。

2. 用户在连接器上执行 `npm run channel -- agent init`，填写 `agent.local.yaml` 中的 Channel HTTPS 地址与自己的 runtime。这个文件选择处理任务的 Agent：OpenClaw 由 `runtime.agentId` 指定，ACP 使用配置的本地 harness 和工作区。不同设备应使用不同配置和不同凭据。保留 `channel.tokenFile` 引用，其父目录必须存在；首次配对会创建随机设备令牌，已有文件不会被覆盖。也可用 `channel.tokenEnv` 引用自行生成的 32 随机字节 base64url 字符串。

3. 确认目标是可信 Channel，使用邀请对应的 GitHub 用户身份配对。例如在已用该身份登录 GitHub CLI 的终端：

   ```sh
   gh auth token --hostname github.com | npm run channel -- agent pair ./secrets/invite.private agent.local.yaml
   ```

   也可由秘密管理工具注入短期用户令牌 `CHANNEL_PAIR_GITHUB_TOKEN`。配对时 GitHub 用户令牌会发给 Channel 以核对用户身份；不要放进命令参数、YAML 或聊天。后续仓库操作只用设备令牌。记下返回的 `deviceId` 供撤销时使用；删除已消费的邀请文件。若配对响应中断，保留本地设备令牌，用下一节的只读查询确认，不要自动重新配对。

## 启用、改规则、停用

例如在 3.183 上创建 `xallor.local.yaml`，只处理指定仓库中的提及评论。App 必须已安装覆盖该仓库，配对用户必须有该仓库当前的 **admin** 权限，write 权限不足。

```yaml
owner: xallor-ai
repo: xallor
expectedRevision: 0
declaration:
  enabled: true
  requireMention: true
  events: [issue_comment.created]
```

```sh
npm run channel -- agent repo status xallor.local.yaml agent.local.yaml
npm run channel -- agent repo apply xallor.local.yaml agent.local.yaml
npm run channel -- agent repo status xallor.local.yaml agent.local.yaml
```

`status` 仅读服务端；`apply` 只提交指定文件中的一个仓库。两者都返回本地期望 `desired` 和服务端结果 `binding`（首次未登记时为 null），包括实际修订 `binding.revision`。仓库操作无需模型令牌；接收任务时另行启动 `npm run channel -- agent run agent.local.yaml`。没有监听本地目录或按缺失项自动删除仓库的后台同步。

| 状态 | 含义 |
| --- | --- |
| `local_pending` | 本地要求启用或修改，当前没有已确认匹配的有效规则。 |
| `active` | 服务端确认启用，生效规则与本地期望一致。 |
| `disable_pending` | 本地要求停用，尚未确认服务端存在已停用记录。 |
| `disabled` | 服务端已确认该仓库停用。 |

**改规则：** 先 `status`，核对所有者、现有事件和修订；把 `expectedRevision` 改成刚读到的修订，再修改 `declaration` 并 `apply`。例如保留评论提及，同时增加 Issue 创建时的提及，可写 `events: [issue_comment.created, issues.opened]`。只有启用 `issues.labeled` 时才能并且必须设置 `triggerLabel`。仓库事件与写仓权限独立。

**停用：** 先查询最新修订，把文件改为下例后显式 `apply`（2 仅为示例）。停止进程、掉线、删除或损坏文件均不会停用仓库。

```yaml
owner: xallor-ai
repo: xallor
expectedRevision: 2
declaration:
  enabled: false
  events: []
```

**错误与重试：** 网络中断或响应无效时进程返回非零，`unconfirmed` 表示服务端可能已经写入，先恢复连接并 `status`。409 冲突不会覆盖服务端或自动重试；比较服务端的新规则，决定是否基于其修订重新提交。`installation_scope` 检查 App 安装和选仓；`administrator_permission` 检查配对用户的仓库管理员权限；`device_unauthorized` 检查连接器凭据和撤销状态；`binding_owner` 表示该仓库已有其他设备归属。`github_unavailable` 表示此次无法核实 GitHub 状态。

## 撤销丢失的设备

管理员在自己的机器执行 `npm run channel -- admin revoke http://127.0.0.1:18896 DEVICE_ID`。撤销后不能用旧设备令牌继续操作。已发往 GitHub 的请求仍需核对实际结果；停用记录保留归属，不支持靠删除文件、改名或普通登记抢占。以上步骤是操作指南，真实环境验收与本地测试的证据见[能力台账](capabilities.md)。
