# 内网主动连接设计与实施计划

状态：已实现并完成受控公网闭环；取代此前要求 ECS 主动访问内网 OpenClaw 的部署假设。

## 目标拓扑

GitHub → ECS Webhook → SQLite 任务。内网连接器主动 HTTPS 拉取任务，调用本机 OpenClaw Responses，再把结果回传 ECS。ECS 始终保有 App 私钥、GitHub token 和操作授权。内网无需公网端口或 SSH 隧道。独立连接器是配套进程，不宣称 OpenClaw 原生只填 Webhook URL 即可连接。

## 协议 v1

- 公网仅新增 POST `/connector/v1/claim`、`/connector/v1/tasks/{uuid}/tool` 和 `/connector/v1/tasks/{uuid}/result`。必须独立 connector Bearer token，不能用管理 token。管理 `/tasks/*` 继续不向公网代理。
- 云端 `connector` 配置 `workerId`、`tokenFile/Env`、`timeoutMs`（领取后执行期限）。旧云端runtime直连配置已移除，避免同时保留偏移的产品入口。
- 单个云实例配置一个可信连接器身份；该身份可领取此实例 enabled bindings 的任务。多租户/多 worker 路由不冒充已支持。
- claim 空 JSON；204 无任务；200 `{task,leaseToken,expiresAt}`。claim 必须先原子持久化 assignment，再经过 GitHub actor 授权，之后才向连接器透露任务。投递响应丢失不会重发任务。
- tool JSON `{leaseToken,name,args}`；服务端从存储载入任务身份与范围，每次调用重新授权；只允许 read_issue/read_file，模型不能指定 owner/repo/actor。
- result JSON `{leaseToken,status,text?,responseId?}`；status succeeded/failed/unknown。数据库原子提交结果与去重摘要后才回200；完全相同结果可重复确认，不触发再次执行；冲突结果409。工具请求仅运行中且未过期有效。
- assignment 期限过后或服务端重启，执行中任务标记 unknown、同binding继续阻塞，不重新排队。未知状态走既有人工对账流程。

## 连接器

单独 YAML：channel.baseUrl（HTTPS origin；仅localhost测试允许HTTP）、channel.tokenFile/Env，runtime（本机OpenClaw配置），stateFile、pollIntervalMs、requestTimeoutMs。连接器不监听端口，不持有GitHub私钥。

本地持久journal保存领取/执行/结果阶段。调用模型前先落盘；重启遇到执行中记录只回传unknown，不重新执行。最终结果网络失败仅重复提交相同结果；领取超时只能继续轮询，不能认为上一任务不存在而重发模型。journal有单进程锁，避免两个进程共享同一个状态库执行同任务。

## 实施任务

- [x] 云端原子领取、assignment校验、超时/重启收束和结果幂等测试与实现。
- [x] 受认证HTTP路由、工具授权、publication-only worker；泄漏/错误/越权回归。
- [x] 内网journal与主动pull客户端；本机OpenClaw复用现有Connector；重启/断网/重复确认测试。
- [x] 云/内网配置schema、CLI init/check/run、Compose配套与公网路由。
- [x] 真实HTTP双端测试（服务端不连接内网）、部署冒烟、文档、独立评审。
- [x] 公网真实部署与GitHub/模型闭环单独验收，不把模拟结果当成成功。

配置/HTTPS层已在5254b50保存；该提交自身未完成本主动连接能力，不能作为整个目标完成证明。

## 已验证的主动连接证据

双端真实HTTP测试：云端配置不含内网地址，实际Agent主动调用claim/tool/result，并通过实际OpenClawConnector完成Responses工具续调用（模型/API为fixture）。容器验证：实际Agent服务无ports、UID1000、TLS验证开启、崩溃journal恢复unknown、容器重建后继续认证轮询。错误ACK、数据库临时写失败、重复结果、过期lease、权限撤销均有回归测试。具体结果与生产联调分开记录。

真实GitHub/模型及重复投递结果见 [主动连接验证记录](outbound-validation-20261122.md)。
