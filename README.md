# GitHub Agent Channel

GitHub Issue/PR 普通评论中的明确 `@mention` 会交给用户已有的 Agent Runtime 分析，再由 Channel 受控回帖。OpenClaw 是第一个 Connector；Channel 负责 Webhook 验签、任务持久化、授权边界和最终回帖。

当前版本只开放 `read_issue`、`read_file` 和最终评论回写。它不会修改文件、创建分支/PR、执行 Git/Shell 或合并代码。

## 选择部署模式

成熟部署把 HTTPS 放在 Channel 外面。仓库提供三种路径：

| 模式        | 适用场景                                    | 入口                                              |
| ----------- | ------------------------------------------- | ------------------------------------------------- |
| Native Node | 本地开发、单进程调试                        | Node 直接监听 HTTP；用 `CHANNEL_CONFIG` 指定配置  |
| `external`  | 已有 Nginx、云负载均衡或 Kubernetes Ingress | Channel 只绑定回环端口，生成 `nginx-webhook.conf` |
| `caddy`     | 独立 ECS、没有现成 HTTPS 入口               | 生成 Caddy 服务，自动申请/续期证书                |

公网只允许精确转发 `POST /webhooks/github`。`/tasks/*` 和其他路径应在入口层拒绝；管理 Bearer token 不能替代网络隔离。

## 快速开始

要求 Node.js 24。容器生命周期命令要求 Docker Compose 2.20+ 插件（`docker compose`）；旧版独立命令 `docker-compose` 不受支持。运行 `npm ci` 后初始化配置：

```sh
npm ci
npm run channel -- init ./channel-data
```

这会创建 `channel-data/config.local.yaml` 和 `channel-data/secrets/`，不会覆盖已有文件。编辑配置并放入四个 secret：App 私钥、Webhook Secret、Runtime Token、管理 Token。配置可以为每个 secret 选择 `*File` 或 `*Env`，必须且只能选择一种。

```sh
npm run channel -- config check ./channel-data/config.local.yaml
npm run channel -- doctor ./channel-data/config.local.yaml
npm run channel -- deploy render ./channel-data/config.local.yaml ./channel-data/.channel
```

`doctor` 是离线检查：验证配置、secret 引用和本机 `docker compose version`，不会访问 GitHub、OpenClaw 或公网域名，也不会发表 Issue 评论。

### Native Node

开发时可以不启动 Compose：

```sh
# Linux/macOS
export CHANNEL_CONFIG="$PWD/channel-data/config.local.yaml"
npm run build
npm start

# PowerShell
$env:CHANNEL_CONFIG = (Resolve-Path .\channel-data\config.local.yaml)
npm run build
npm start
```

`dataFile` 必须指向当前用户可写的持久目录；容器路径 `/data/channel.db` 只适用于 Compose。Native Node 的 `runtime.baseUrl` 必须是本机可达的 Runtime 地址。

### External gateway

`deployment.mode: external` 生成的 Channel 监听容器端口 `3000`，宿主只发布 `127.0.0.1:18896`（可用 `deployment.localPort` 修改）。如果入口容器和 Channel 使用同一 Docker 网络，设置 `deployment.network`，生成器会使用稳定的服务别名；同时生成 `nginx-webhook.conf` 供现有 HTTPS server block 审核后 include。

```sh
npm run channel -- deploy up ./channel-data/.channel
npm run channel -- deploy status ./channel-data/.channel
npm run channel -- deploy down ./channel-data/.channel
```

`up` 等价于 `docker compose ... up -d --build --wait`；`status` 使用 `ps`；`down` 不删除卷。生成目录是不可变 bundle：配置变化时请使用新目录，避免覆盖当前运行版本。

### Caddy edge

`deployment.mode: caddy` 还会生成固定版本的 Caddy `2.10.2-alpine`，暴露 80/443，并将只有 `POST /webhooks/github` 的请求转到 Channel。要求域名 DNS 指向该 ECS，且 80/443 可达。若服务器已有 80/443 服务，不要启用此模式，应使用 `external`。

## Secret 约定

生产 Linux 主机上的 File secret 应限制访问：文件建议 `0600` 且 owner 为容器用户 UID 1000，或 `0640` 且 group 为 1000；父目录应限制为 owner/group 可进入。PEM 保留换行，普通 token 文件去掉首尾空白。不要把 secret 内容写入 YAML、命令行、日志、Issue 或 Git。

Compose 生成器会把 `*File` secret 以 Compose secret 文件挂载到 `/run/secrets/...`；`*Env` secret 使用 Compose 的 `environment` secret source。后者是 Docker Compose 能力，不适用于 `docker stack deploy`。不要把私钥放进 Dockerfile 或 build context。

## GitHub App

GitHub App 安装到目标仓库后，启用 `Issue comment` Webhook 事件，Webhook URL 使用：

```text
https://<your-domain>/webhooks/github
```

Webhook secret 必须与 Channel 配置一致。配置以下 Repository permissions：Metadata Read、Contents Read、Issues Read and write、Pull requests Read and write。Binding 同时固定 installation ID、repository ID、owner 和 repo；评论作者还必须拥有 `admin`、`maintain` 或 `write` 权限。

## 数据、升级与回滚

Channel SQLite 数据在 `channel-data` 卷中。停服后备份数据库及 `-wal`、`-shm` 文件；恢复前保留原始备份。不要通过删除数据库、重复投递 Webhook 或重启来清除 `unknown` 状态。

升级时保留相同 `deployment.projectName`，先停止旧 bundle（不删除卷），备份 SQLite，再启动新 bundle 并检查 `status` 和 `/healthz`。同名项目是原位替换，不能在启动新 bundle 后再对旧 bundle 执行 down，否则会停止同一项目。回滚时停止当前项目，切回已记录的旧源码提交和旧 bundle 再构建启动。若曾升级数据库格式，恢复兼容备份。不要使用 `down -v`。

## 验证边界

```sh
npm test
npm run typecheck
npm run build
npm run format:check
```

本地测试覆盖配置解析、File/Env secret、脱敏、external/Caddy 生成、路径隔离、签名 Webhook、权限、去重和恢复。真实容器与 HTTPS 路由的隔离验收已通过，见[本轮验证记录](docs/deployment-validation-20261122.md)。其中 Runtime/GitHub 使用合成实现；公网 ACME 和真实 GitHub 回帖仍须单独验收。

配置与架构约束见 [docs/deployment-design.md](docs/deployment-design.md)，运维恢复见 [docs/operations.md](docs/operations.md)。
