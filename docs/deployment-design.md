# 配置与部署产品化设计

> 当前网络方向已修正为内网主动连接ECS；云端直连Runtime不再支持。部署与协议以 [主动连接计划](outbound-connector-plan.md) 和 [运维说明](operations.md) 为准。本文早期设计/验收保留作历史记录。

状态：实施中；本文描述产品边界，不代表生产部署成功。

## 用户入口

用户维护一份 YAML，敏感值通过 `*File` 或 `*Env` 引用。CLI 负责初始化样例、严格校验、脱敏诊断、生成 deployment bundle 和生命周期命令。开发环境可直接运行 Node；已有 HTTPS 入口使用 external；独立 ECS 可使用仓库生成的 Caddy。

## 配置契约

四类 secret 必须且只能选择一个来源：GitHub App private key、Webhook Secret、OpenClaw Runtime token、Channel admin token。File 路径相对配置文件目录解析；PEM 保留换行，单行 token 去除首尾空白；错误不回显值。

`deployment.mode` 为 `external` 或 `caddy`。`publicUrl` 只接受无路径、凭据、端口、query/fragment 的 HTTPS origin。`network`、`projectName` 和 `localPort` 都做严格校验。生成容器运行配置固定为 `0.0.0.0:3000`、`/data/channel.db`、`/run/secrets/*`。

## Edge 与路由

业务服务只负责 HTTP、验签、任务和授权。HTTPS、证书和公网路由属于独立 Edge：

- external：生成 `nginx-webhook.conf`，只转发 `POST /webhooks/github`，其余入口路由保持现有站点行为。
- caddy：生成固定 `caddy:2.10.2-alpine`、80/443、证书持久卷和精确 Webhook 路由；已有 80/443 时禁止启用。

`/tasks/*` 不通过公网入口；健康检查从私网或回环执行。

## Bundle 与生命周期

Compose、运行时配置、Nginx/Caddy 路由和 secret 引用构成一个 bundle。bundle 内容不可覆盖：配置变化使用新目录；旧 bundle 留作回滚。`up` 使用 `-d --build --wait`，`status` 使用 `ps`，`down` 不删除卷。Docker Compose v2 是 CLI 前置条件，旧 `docker-compose` 不受支持。

SQLite 数据位于持久卷。备份包括数据库和可能存在的 WAL/SHM 文件；升级保留 projectName，先停旧服务并备份，再启动新 bundle；回滚需同时恢复对应源码提交、bundle、网关配置及兼容数据库备份，不删除卷。

## 诊断与验收

`config check` 和 `doctor` 是离线操作：不访问 GitHub、OpenClaw、DNS、ACME 或公网。真实 E2E 作为单独受控操作，记录 GitHub App、域名、Runtime、路径隔离、错误签名和幂等结果。

验收包括配置互斥引用、秘密脱敏、Compose/Caddy/Nginx 生成、单元测试、类型检查、构建、格式检查和现场部署证据。未有现场参数时不得把离线验证描述为真实 GitHub 闭环。
