# 主动连接版验证记录（2026-11-22）

> 状态：指定版本与时间点的验证证据。本文真实验收仅覆盖一个绑定仓库的读取/回帖；不证明代码修改、项目测试、PR 创建或其他 Runtime，也不是当前持续在线状态。当前范围见[能力台账](capabilities.md)。

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

## 真实 GitHub 与模型闭环：通过

App 事件订阅生效后，实际投递发现缺少 X-Hub-Signature-256，服务端正确拒绝400。已将预先生成的Webhook Secret同步到App；随后使用新评论触发，没有用手工构造的payload替代GitHub投递。

- 测试 [Issue #1](https://github.com/xallor-ai/github-agent-channel/issues/1)。
- [触发评论](https://github.com/xallor-ai/github-agent-channel/issues/1#issuecomment-7078248693)。
- GitHub delivery GUID：154ed398-e665-11f1-815e-372c3422834e，issue_comment/created，含签名，HTTP202。
- 云端任务 e7d35862-8776-41d9-835c-817c87b7abb7：succeeded，deliveryStatus=sent，error=null。
- 实际HTTPS工具请求两次均200，结果回传一次200。
- [机器人回帖](https://github.com/xallor-ai/github-agent-channel/issues/1#issuecomment-7078258127)，含OUTBOUND_E2E_OK与匹配任务marker。
- 机器人自己的评论delivery返回200并被忽略，没有启动新任务。
- 对原delivery执行GitHub Redeliver，仍返回202；数据库保持同一任务，机器人评论数量仍为1。

机器人提到“尚未验收”来自其读取的默认分支旧README，不是此次后台状态的结论。本次通过由实际delivery、持久任务和评论读回共同证明。新代码在codex/outbound-connector分支，未自动合并默认分支。

本次实测范围是一个明确绑定的仓库、真实模型及读Issue/文件后回帖；不扩展为多租户、任意写仓或所有事件处理均已验证。
