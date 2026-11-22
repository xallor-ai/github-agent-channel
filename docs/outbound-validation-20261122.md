# 主动连接版验证记录（2026-11-22）

代码：`b458603`（codex/outbound-connector），前置配置/HTTPS改动5254b50。当前产品方向为ECS接收Webhook，内网Agent主动HTTPS领取和回传，不支持旧云端直连Runtime配置。

## 仓库检查

- 88项测试通过；类型检查、构建、格式检查通过。
- GitHub CI：[运行45008312599](https://github.com/xallor-ai/github-agent-channel/actions/runs/45008312599)，对应b458603，结果success。
- 独立审查发现结果存储失败错误分类问题，已修复：SQLite等基础设施异常503、领域冲突409；回归证明不丢弃未确认结果，也不重复调用模型。

## HTTP与隔离Docker

实际Agent和OpenClawConnector通过本地HTTP协议fixture验证claim→read_issue→Responses续调用→结果→DeliveryWorker。GitHub及模型输出为合成实现。覆盖失权、错误/过期lease、重启unknown、错误ACK、重复结果与存储故障重试。

Docker实测Node24.22.1、Compose5.1.1，两种云端入口及独立Agent容器通过：

```json
{"syntheticOutboundAgentE2E":"passed","realTlsClaimToolResult":true,"model":"synthetic client-side runtime","signedIssueComment":true,"duplicatePublicationCount":1}
{"agentContainer":"passed","ports":0,"crashRecovery":"unknown-not-reexecuted","authenticatedPollAfterRecreate":true,"cloudTls":"verified-local-ca"}
```

Nginx在不重启时跟随Channel IP变化；UID1000读取File/Env secret；SQLite在容器重建后保留。Caddy使用测试内部CA，客户端显式信任CA，没有禁用证书校验。测试资源已清理。

## 实际环境预检

已部署ECS Channel与内网Agent，前者持有App凭据，后者只有connector token与本机OpenClaw token；内网Agent未发布端口。复用已有Nginx HTTPS入口；原站点健康检查保持200。

公网无签名Webhook400、未认证connector401、认证空任务claim204。内网Agent持续出站轮询。ECS容器真实GitHub仓库授权通过，内网Agent容器真实OpenClaw文字请求完成且命中预期回复。具体服务器地址、配置路径和备份位置保存在不进Git的部署记录。

## 尚未确认

GitHub App的Active/Issue comment配置由App管理员操作。最后一次API读取事件列表仍为空，hook/config返回404；不能把界面截图当作已保存证据。

真实GitHub事件→ECS入队→实际模型工具调用→GitHub回帖仍待受控测试。当前仅启用一个指定测试仓库binding。不会从模型预检或fixture声称完整生产闭环。
