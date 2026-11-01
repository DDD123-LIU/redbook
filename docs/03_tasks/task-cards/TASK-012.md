> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../../04_specs/recommendation-count-policy.md)与[最新验收](../../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-012 投递状态、反馈保存与回执

2026-10-29，Codex，用户最新规则：[正文优先推送](../../04_specs/text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

## 2026-10-24 最终审查进度（Codex，当前）

最终验收：C2C c2c_012a I3 **DONE—ACCEPT**，无剩余阻塞发现；Architecture Review及终态三入口一致性关闭。投递/集成最新22/22 EXIT0，原60/111/179证据分层复用。真实新文本1条、回读成功；四输入历史恢复和新WS查询分别记录，当前dislike/revision2、7成功outbox，监听/执行槽停止。交付按task012-delivery-manifest确切本地提交，提交以Git记录为准；原两Serena暂存不混入，不push/部署。012有界实现及审查通过，013需另行指定，本轮停止。余下段落均为对应过程历史；正式结论见task012-delivery-report。

最新I2后：真实新查询及回执已被C2C接受，F2/F3关闭。F1-R1终态reconcile证据检查遗漏已RED复现，并统一send/reconcile/recover的终态核验；最新投递及集成22/22 EXIT0。历史账本与防重索引保持，不重发真实消息。I3最后增量待审，未Git提交；012最终门禁未关闭，013不开始。实际证据见task012-live-summary、task012-c2c-i2-r1-red/green和task012-checkpoint。

下方为I1/I2期间历史进展，当前以本段及最终Review为准。

最新：C2C I1 F1-F3已全部最小修复，相关60/60 EXIT0；用户新查询已由新版实时WS收到，回执成功且返回dislike/revision2。现7event/7成功outbox，当前1/历史2，不重复记账。临时listener和执行槽均已停止且无owner/run。C2C I2已提交实际差异/测试/脱敏证据等待最后审查，尚未提交Git；下方待查询/修复为前一时点。

Gate3、011及005 v0.2前置已核对，用户已指定本卡并明确中断后只续未完成。实现已落盘，Schema v3/现有SDK复用，无迁移/新增依赖。全套179/179、最新受影响111/111有效，独立进程防重/中断恢复与人工偏好集成已验证；不能用旧绿色覆盖后续发现。

Sol四项AR已修复。C2C I1实际审查提出F1成功receipt必须与最终状态/ID一致、F2成功outbox证据损坏不得凭历史状态报已核实、F3核实unknown须落盘；当前只补这三项定向修复，最终DONE尚未取得。

真实新的合成文本1条/0上传/0模型，API成功及精确回读；原011消息不重发。原用户4输入经完整本人平台历史回补，like1→dislike2、两次查询一致、6回执成功含原2澄清。初始2紧凑文本事件和2纯文字post的入口问题已修，不把历史恢复冒称新版实时入口全通过；仅待一条新查询验证，随后停止临时监听。实际状态见`.codex/task012-live-summary-20261024.json`及私有检查点。

本卡尚未最终验收/提交，013直接依赖仍待012关闭，不自动开工。准确续作入口`.codex/task012-checkpoint-20261024.json`、`.codex/task012-resume-packet-20261023.md`；工作区原两Serena暂存保持。

## 2026-10-23 开工检查点（Codex，当前）

用户已明确指定本卡，且本轮只执行012，完成后停止。006/Gate3与011最终交付原证据已核对，开工前置满足。C2C `c2c_012a` ITERATION0 开发前审查实际取得 `PLAN / PROCEED WITH CONSTRAINTS`；F1跨进程派发claim、F2首次成功推荐归属、F3回执独立证据链、F4人工偏好版本验证均纳入实现计划。

当前处于Build，尚未验收、未提交、未真实外发。初始账本只读核对009/010/011均无产品投递attempt或反馈；011已有3条真实合成展示消息不得重发。准确入口：`.codex/task012-plan-20261023.md`、`.codex/task012-task-packet-20261023.md`、`.codex/task012-c2c-plan-20261023.txt`、`.codex/task012-operations-log-20261023.md`。下方“未开工”是本轮启动前历史。不能因文件存在认实现通过，不进入013。

本卡只定义后续实施，不代表当前开工。按编号执行，不自动进入后项；不使用付费API、不增购额度、不接CI、不建设独立网站或App。沿用Node标准库和现有项目生态。

日期：2026-10-21。执行者：Codex。责任：后端投递/反馈状态及本人飞书适配。状态：未开工；实施契约随Spec v1.0封板，开工须用户指定。对应规格：[technical-spec.md §4、§9、§12](../../04_specs/technical-spec.md)。

## 目标与范围

在已授权本人飞书范围内，实现已格式化recommendation的投递意图、单次发送、结果核实、反馈接收和保存后回执。逻辑接口：prepareDelivery(recommendation, expected_generation)、sendPrepared(attempt)、reconcileDelivery(attempt)、applyFeedback(event, expected_revision?)。外部API调用与本地SQLite事务分开；业务保存与反馈outbox在同一事务。

不做批次调度、推荐筛选、质量统计或新的接收者支持；不承诺exactly-once，不自动重发unknown，不将客户端“看过”推定为赞。

## 输入、接口与输出

投递记录使用唯一delivery_attempt_id，含recommendation_id、target_ref、payload_hash、intent/dispatched/returned时间、message_id、状态和核实证据。持久状态统一为pending/intent/succeeded/failed/unknown/cancelled_before_dispatch；网络超时、进程崩溃、回执丢失为unknown；平台明确拒绝且证实未达才为failed。无message_id不得造成功。旧原型别名只按Spec§4.1在导入入口映射，不建第二套状态。

反馈输入含event_id、来源消息/编号、反馈值、接收时间和expected_revision；值包括赞/踩/看过/查询/更正/指令。输出saved/duplicate/clarification_required/save_failed。保存成功需同事务写event/current/history/processed event/outbox；歧义或未知编号不改旧评价。回执仅在事务成功后发出；回执自身也有成功/失败/unknown状态。

## 开工前置与验收

前置：TASK-011通过并提供完整payload及payload_hash；005 v0.2契约已纳入TASK-006并Gate3通过；用户按编号指定012。真实本人飞书操作在既有授权内，不能扩展到其他会话；不要求重确认已知业务选择。

本地使用Node标准库、隔离SQLite和合成adapter验证：停止标志/代次变化后未派发意图取消；成功回执+message_id归成功且重复输入不重发；外部超时、进程在派发后崩溃或回执解析失败均保留unknown；精确message_id回读7项同条；无ID时只有本人会话内唯一编号/目标/payload且完整分页才确认，零/多匹配、403、超时和不完整页均unknown；更正需expected_revision一致；event重复不增历史；保存失败不回执且可重试；回执发送失败不回滚业务。跨日旧unknown仍核实，不被清除。

若需真实外发，严格限定已有本人目标、已批准payload类型及单次计划；既有send1/upload9不重发。Review核对交易边界、状态分支、敏感数据不入日志。计划证据：.codex/task012-testing-<日期>.md、.codex/task012-results-<日期>.json、.codex/task012-review-<日期>.md。仅现有官方SDK和Node标准库，无CI/额外依赖或虚构命令。

## 停止、回退与后续

停止时不启动新发送；核实已经派发的attempt，unknown保持待查，succeeded不撤回。失败时恢复本地事务/备份，不能回滚平台已发消息。跨日保留成功/失败/unknown和反馈历史。Review完成后不自动进入013。

未决与开工：真实多实例并发和长期可靠性仍待验证；unknown须有可靠核实证据才能成功归账。B1/B3/B4按用户已确认方案和边界处理，不再列为006硬阻塞；006规格Gate3已通过，本卡仍未开工，须用户按编号指定。
实施顺序的直接前置：TASK-011。同时必须满足TASK-006与Gate3；技术输入及额外依赖以本卡正文为准。

C2C F2/F4/F5补充：持久投递状态统一为Spec§4.1枚举；原型别名只入口映射。最后许可检查与SDK派发仍有竞态窗口，可能派发者以原批原实际版本进入核实，不承诺零竞态。派发前相关baseline/preference/strategy变化使旧decision失效，重筛产生新decision。覆盖检查后/派发前及派发后崩溃，不盲重发、不改历史归属。
