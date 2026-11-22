# 配置与部署升级实施计划

> 当前网络方向已修正为内网主动连接ECS；云端直连Runtime不再支持。部署与协议以 [主动连接计划](outbound-connector-plan.md) 和 [运维说明](operations.md) 为准。本文早期设计/验收保留作历史记录。

目标是让开发者用一份 YAML 和明确的 secret 引用完成 Channel 配置、渲染、校验和生命周期管理，同时保留已有 HTTPS 网关。

## 已实现

- File/Env secret 互斥解析，路径相对配置文件目录，PEM 和 token 处理规则明确。
- 严格配置校验：deployment mode、HTTPS origin、网络名、项目名和回环端口。
- CLI：`init`、`config check`、`config print-public`、离线 `doctor`、`deploy render/up/down/status`。
- external 生成 Channel Compose 和 Nginx 精确 Webhook 路由；caddy 生成固定版本 Caddy 与证书卷。
- 容器运行配置规范化为 `0.0.0.0:3000`、`/data/channel.db` 和 `/run/secrets/*`。
- 生成 bundle 不覆盖内容不同的既有文件；升级通过新目录完成，down 不删除卷。

## 验证状态

仓库级测试、类型检查、构建和格式检查由 CI 覆盖。部署渲染测试覆盖 File/Env 引用、Caddy 路由、Nginx 路由、localhost 端口和秘密不泄露。

Docker隔离验收已经通过（两种模式、真实Nginx/Caddy、非root、持久性、签名评论任务和幂等），详见 [验证记录](deployment-validation-20261122.md)。

生产接入仍需现场参数：

- ECS 只有旧版 `docker-compose 1.29.2`，现代 `docker compose` 2.20+ 插件尚未安装。
- `选定域名` 现有 Nginx Gateway 路由尚未写入或 reload。
- 公网 ACME、GitHub App 事件投递、OpenClaw 生产 Runtime 和真实回帖闭环尚未验收。
- Caddy 模式需要独立 ECS 和空闲 80/443；已有 Gateway 的 ECS 应使用 external。

## 分阶段计划

1. **本地配置**：`init` → 编辑 YAML/secret → `config check` → `doctor`。doctor 只做离线检查，不访问远端。
2. **渲染审核**：生成新 bundle，检查 Compose、运行时配置、Nginx/Caddy 路由和 secret 来源。
3. **预发布启动**：安装 Compose v2，启动新 bundle，检查容器 health、私网 `/healthz` 和 Runtime 连通性。
4. **网关接入**：审核精确 `POST /webhooks/github` location，执行 `nginx -t` 后 reload；公网其他路径不进入 Channel。
5. **受控 E2E**：用受控仓库/账号发送 ping、无效签名和一条 mention，记录任务、Runtime、回帖和重复投递行为。
6. **运维交付**：保留旧 bundle、卷备份、Gateway 模板和回滚命令，形成可审计版本记录。

## 使用约束

- Native Node 的 `dataFile` 和 Runtime 地址按本机环境配置；容器路径只用于生成 Compose。
- File secret 生产建议 `0600` + UID 1000 owner，或 `0640` + group 1000；父目录需受限。
- Env secret 通过 Compose environment secret source；不适用于 `docker stack deploy`。
- 不把 secret 内容写进日志、命令参数、生成文件或镜像 build context。
