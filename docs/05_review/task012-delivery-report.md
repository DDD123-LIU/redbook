# TASK-012 投递与反馈交付记录

2026-10-29，Codex，用户最新规则：[正文优先推送](../04_specs/text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

日期：2026-10-24。执行者：Codex。范围：仅TASK-012。档位：实现S3，本人飞书操作按S4边界。最终状态以末尾审查关闭记录为准。

## 实现和调用

沿用007的SQLite Schema v3、010候选与版本、011完整display item、003官方飞书接入及005 v0.2反馈契约。无新依赖、无数据迁移。接口和完整输入见[投递与反馈说明](../04_specs/delivery-feedback-contract.md)。

```text
011 buildBatch释放执行槽
  → prepareDelivery(displayItem)
  → sendPrepared(attempt_id)
  → receipt及checkpoint
  → 成功归账 / 明确失败 / unknown核实

本人实时事件 → applyFeedback事务
  → event + current + history + outbox
  → sendReceipt
  → queryFeedback / 明确revision更正
```

`createFeishuTransport`提供单次send和精确lookup；`createFeishuListener`提供临时start/stop。成功必须平台依据和message_id。消息构建和上传不算成功。unknown不盲重发；零匹配、403、超时、丢页和多匹配都保留不确定。成功证据损坏保留历史状态及防重，核实入口报告evidence_unverifiable。平台uuid只有有限幂等窗口，不承诺绝对仅发送一次。

反馈支持`1赞`或`1 赞`、`1踩`、`1看过`、`查询1`及`更正 1 踩 修订1`。单发“赞”须引用原消息。编号歧义先澄清；更正只更新当前有效结果，保留历史。保存失败不回成功；保存成功但回执异常只恢复outbox。关注/探索、内容、批次及实际偏好/策略版本均保留关联。

明确修改偏好保存来源事件、父版本和具体操作。单次反馈只提供依据，不覆盖全部偏好；后续分析继承明确指令并校验父指针。“再来3条”“探索3条”只建立可去重的待编排请求，不回复已生成或已发送。无探索指令不创建探索请求。

## 验证证据

- 本地全套曾179/179；最终功能增量相关111/111；C2C I1三项修复后的投递/反馈/平台/集成组合60/60、EXIT0。旧有效证据复用，没有重采集、下载、重跑模型或重发011消息。实际输出见`.codex/task012-local-full-20261024.txt`、`.codex/task012-final-related-20261024.txt`、`.codex/task012-c2c-i1-related-20261024.txt`。
- I2最后F1-R1遗漏终态reconcile证据校验已实际RED复现；send/reconcile/recover成功及失败终态统一核验，cancelled_before_dispatch独立处理。只补受影响投递及集成22/22、EXIT0，日志`.codex/task012-c2c-i2-r1-red-20261024.txt`和`.codex/task012-c2c-i2-r1-green-20261024.txt`。无需重做已接受的真实链路。
- 隔离SQLite及独立进程覆盖claim并发、SDK调用后退出、成功回执落盘后归账前退出、反馈提交后回执前退出、回执文件后归账前退出。成功不重发、反馈不重计；旧unknown不替代成功证据，outbox核实unknown持久化后重开仍保留。
- 本轮只新投递合成文本1条，API成功、message_id关联及完整精确回读成功，0上传/0模型。实际四条用户输入通过本人完整有界历史恢复，形成like/revision1→dislike/revision2；两次历史查询分别读到对应版本。原两次错误澄清保留，未改写为当时成功。
- 修复后新查询于北京时间02:55:41由实时WS收到，保存与handler结果哈希关联核对，回执成功，返回dislike/revision2。最终7event/7成功outbox、1当前评价/2历史变更、1成功投递。历史恢复与新版实时证据分别标记，见`.codex/task012-live-summary-20261024.json`。
- 临时监听随后停止，原进程退出0，执行槽stopped且owner/run为空。未部署正式运行或持久调度。没有移动端、真实平台故障全覆盖、长期可靠性或95%推荐质量结论。

## 审查与恢复

开发前C2C I0 `PROCEED WITH CONSTRAINTS`复用。Sol实际Architecture Review四项发现已修并有回归。C2C I1三项恢复边界已分别RED→GREEN：最终投递证据一致性、成功outbox证据可验证性、崩溃intent核实unknown落盘。I2最后遗漏入口修复后，I3已独立读取实际差异和执行输出35，取得DONE—ACCEPT。原审查和处理记录留在`.codex/task012-c2c-*`及`.codex/task012-architecture-findings-20261024.md`。

Serena已调用initial_instructions、激活redbook、定位符号及引用；同名函数/属性时指定符号编号后返回调用方。C2C内置浏览器超时后按用户指令切lite ego，复用同一项目会话及有效连接，无重复INIT。失效空间先盘点再恢复，未扰动采集或飞书客户端。工具失败和替代记录见`.codex/task012-operations-log-20261024.md`。

准确续作入口：`.codex/task012-checkpoint-20261024.json`和`.codex/task012-resume-packet-20261023.md`。详细消息、账号、数据库、已收事件及回执关联只保存在Git外的private检查点。恢复先查实际文件/DB/进程；成功消息不重发，unknown先核实，已保存业务只恢复未完回执。

## 最终关闭

C2C `c2c_012a` I3已实际取得 **DONE—ACCEPT I3 — TASK-012**，执行输出35及源码/文档核对完成，无剩余阻塞发现。原始结论见`.codex/task012-c2c-review-i3-20261024.txt`。Architecture Review四项及C2C后续发现均有处理与回归。已接受的本地/真实证据范围内，本任务通过；提交前再读实际验证结果并按清单确切本地提交，提交ID以Git为准。原两项Serena暂存保持。本段覆盖下方待I3历史。

本轮不再有012范围内待实现项。长期可靠性、移动端、正式调度与真实故障全覆盖仍未验；这些限制不转写为已通过。准确提交后012→013实现交付依赖满足；013仍需单独指定，不自动开工。已成功消息不重发，保存反馈不重计；未来恢复先核对检查点及Git、DB、进程。

北京时间12:00规则保持。未启动TASK-013、正式调度或部署，没有push。
