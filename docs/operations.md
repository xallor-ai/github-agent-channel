# 运维与恢复

本文描述 Channel 的可重复部署、升级、备份和人工对账。它不代表真实 GitHub/ECS 闭环已经验收。

## 配置与 secret

从 [channel.example.yaml](../deploy/channel.example.yaml) 复制配置。每项敏感值必须且只能设置一个引用：`github.privateKeyFile`/`github.privateKeyEnv`、`github.webhookSecretFile`/`github.webhookSecretEnv`、`runtime.tokenFile`/`runtime.tokenEnv`、`server.adminTokenFile`/`server.adminTokenEnv`。

File secret 路径相对配置文件目录解析。Linux 容器以非 root UID 1000 运行：推荐 secret 文件 `0600` 且 owner UID 1000；也可 `0640` 且 group 为 1000。父目录只允许部署用户和容器所需 group 进入。PEM 保留换行，token 文件会去除首尾空白。不要把内容写进 YAML、命令参数、日志、Issue 或 Git。

Compose 生成器使用 Docker Compose secret 文件挂载到 `/run/secrets/`；Env 引用使用 Compose `environment` secret source。`docker stack deploy` 不支持这种 environment secret source。Native Node 运行时直接读取 File 或进程环境。

## GitHub App

启用 `Issue comment` 事件，Webhook URL 为 `https://<your-domain>/webhooks/github`，设置随机 Webhook Secret。权限为 Metadata Read、Contents Read、Issues Read and write、Pull requests Read and write。配置 installation ID、repository ID、owner、repo 和 bot login；binding 必须与安装范围完全匹配。

## 三种运行方式

### Native Node

```sh
export CHANNEL_CONFIG="$PWD/channel-data/config.local.yaml"
npm run build
npm start
```

PowerShell：

```powershell
$env:CHANNEL_CONFIG = (Resolve-Path .\channel-data\config.local.yaml)
npm run build
npm start
```

Native Node 的 `dataFile` 必须是本机可写持久路径，`runtime.baseUrl` 必须从本机可达。

### External gateway

```sh
npm run channel -- deploy render channel-data/config.local.yaml channel-data/.channel
npm run channel -- deploy up channel-data/.channel
```

生成器会把容器内配置规范化为 `server.host=0.0.0.0`、`server.port=3000`、`dataFile=/data/channel.db`，宿主只发布 `127.0.0.1:18896`（或 `deployment.localPort`）。生成 `nginx-webhook.conf`，只允许 `POST /webhooks/github`；入口容器与 Channel 共用 Docker 网络时设置 `deployment.network`。

### Caddy

`deployment.mode: caddy` 会生成固定 Caddy `2.10.2-alpine`、80/443 入口和持久证书卷。DNS 和端口条件由用户负责。服务器已有 80/443 时使用 external，不能同时启动第二个公网入口。

## Doctor 和生命周期

`doctor` 是离线检查，只读取配置、解析 secret 引用并执行 `docker compose version`；不会访问 GitHub、OpenClaw、DNS、ACME 或 Webhook。

现代 Compose 生命周期为：

```sh
npm run channel -- deploy up channel-data/.channel
npm run channel -- deploy status channel-data/.channel
npm run channel -- deploy down channel-data/.channel
```

CLI 只使用 `docker compose` 2.20+ 插件，不回退到旧 `docker-compose`。`up` 使用 `-d --build --wait`，`status` 使用 `ps`，`down` 不带 `-v`。如果配置变化，渲染到新目录；生成 bundle 不覆盖不同内容的旧文件。

## 数据备份、升级和回滚

默认 SQLite 文件为 `/data/channel.db`，位于 `channel-data` 卷。停服后备份 `channel.db`、`channel.db-wal` 和 `channel.db-shm`（若存在），保留校验和与时间戳。恢复前保留原始卷快照。

升级：

1. 复制配置和 secret 引用，生成新的部署目录。
2. 执行 `config check`、`doctor` 和 `deploy render`。
3. 保持 `deployment.projectName` 不变，先停止旧 bundle（保留卷），备份 SQLite。
4. 在新 bundle 上执行 up 并检查 status、私网 `/healthz` 和入口。不要再对旧 bundle 执行 down：同名项目共享容器身份。

回滚时停止新 bundle，启动旧 bundle；禁止 `down -v`。配置变更和镜像版本应可追溯。

## unknown 对账

进程启动会将遗留 `running` 标记为执行 `unknown`，将 `sending` 标记为回帖 `unknown`；不会自动重放外部副作用。执行 unknown 时先确认 Runtime 任务已停止，再调用：

```json
{ "confirmedStopped": true, "resolution": "failed" }
```

回帖 unknown 时在目标 Issue/PR 中核对带有 `<!-- github-agent-channel:<task-id> -->` 的评论，再调用：

```json
{
  "confirmedReconciled": true,
  "resolution": "sent",
  "url": "https://github.com/OWNER/REPO/issues/123#issuecomment-456"
}
```

若确认没有成功且关闭投递：

```json
{ "confirmedReconciled": true, "resolution": "failed" }
```

这些操作不创建评论，也不触发重发。不要删除数据库或重复投递来“解决” unknown。

## 验证边界

`npm test`、类型检查、构建和格式检查是仓库级验证。真实 App 安装、有效签名、模型调用、GitHub 回帖、域名 ACME 和 ECS 入口路由必须单独验收并记录，不能用离线测试代替。
