# TASK-013 Host additional operation 窄规格

日期：2026-10-28。执行者：Codex。

## 契约

- `runTask013Host`只允许`operation:'additional'`与`source:'manual_daily'`，并要求`invocation.explicitRequest === true`、非空`commandId`和原始`requestText`。
- host沿用现有配置校验、生产开关、同一正式DB、runtime装配和按配置重新绑定Page的流程。
- host固定调用`orchestrator.run({kind:'additional_follow', commandId, requestText, requestSource:'feedback', tab})`。调用方不能指定`direct_user`。
- 编排器必须通过`feedback.pendingRequests({commandId})`验证已保存事件的owner/app/chat、原文、请求类型/目标、稳定commandId和证据引用。无对应pending或来源不匹配时拒绝，不创建追加批。
- 通过验证后，目标固定为3；同一commandId重放复用原批，不创建第二批。每日入口和recover契约不变。

## 验收

隔离DB测试覆盖：无pending事件时追加入口拒绝且批数为0；真实`applyFeedback('再来3条')`产生的pending请求可进入host追加入口并形成目标3的批；同command重放返回同一批。测试在采集能力缺失处阻断，不触发采集、模型、投递或网络。
