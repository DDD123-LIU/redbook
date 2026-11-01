# TASK-012 投递与反馈接口

2026-10-29，Codex，用户最新规则：[正文优先推送](text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

## 2026-10-26 TASK-014 所需归账时间细化（Codex）

成功、失败或unknown归账事务只取得一次`accountedAt`。attempt的`returned_at`及状态历史、recommendation状态历史共用该时刻；成功时recommendation和delivered_content的`first_success_at`也共用该时刻。该时刻表示确认/归账，不表示原发送时间；原发送仍按`dispatched_at`及原工作记录核对。

此改动供014按`as_of`重建历史，不改投递三态、反馈值或既有历史。旧成功记录不要求毫秒完全相等；依据完整因果顺序和共同时间边界核对。混用时钟、缺证据或时间边界不明确时，014保留成功事实并报告待核实，不静默剔除以改善指标。裁定记录见`.codex/task014-account-time-ruling-20261026.md`。实现与最终验收以TASK-014本轮测试和Review为准，不回写TASK-012历史结论。

## 2026-10-25 TASK-013 I4 窄恢复细化（Codex，待实现delta Review）

不改变`reprepareCancelled`公开参数、返回值或既有投递三态。原取消协调者可以是当前明确continue的合法早代祖先；delivery私有证明路径须独立逐代核现有main/command checkpoint，而非信任调用方传入的祖先列表。每代同owner/batch、严格相邻generation、continued_from精确父run、command stage/input/output hash及身份一致，父head必须确切最新静止、pending空；当前命令ID精确匹配，终端仍为本批最新协调者且未过代。完整方案见task013-i4-lineage-plan-20261025.md。

原attempt的intent/取消证据确定授权起点；只合法明确指令链能到达当前协调者。每条推荐所有状态中的最新attempt决定有无后继，不能用旧cancelled记录绕过后继intent/unknown/dispatch或成功。原版本/资格、内容防重、slot expectedGeneration、attempt/recommendation revision、mapping、UUID/ordinal/build/payload及取消证据校验全部保留；旧attempt不复活。

新attempt和映射仍在原原子事务提交，事务中独立重核DB授权链及预核证据快照。坏链必须明确拒绝并保留原ID，不能当作无候选或用新候选补足。此细化属于013现有同批恢复义务，不重写012历史Review/封板业务规格；方案级接受不等于实现或宿主验收通过。

## 2026-10-24 TASK-013 窄接口增补（Codex）

本段记录013消费既有投递/反馈所需的契约细化，不回写012的历史Review结论，不新增Schema或状态枚举。实现审查以TASK-013当前Review为准。

`delivery.cancelPrepared({attemptId,evidenceRef})`只取消有原意图及证据证明尚未dispatch的intent。证据核对owner、目标、应用、原attempt/rec/批、原intent hash，事务内竞争同一revision及dispatched_at为空条件。unknown/已dispatch/成功不取消；重复取消核原取消证据后返回原结果。文件证据准备在事务外，不调用transport。

`await delivery.reprepareCancelled({attemptId,item,continueCommandId,evidenceRef,expectedGeneration})`用于明确继续后重新准备原未发送推荐。evidenceRef对应旧取消证明；当前协调头及持久continue command证据独立核验。当前批/停止/代次、原推荐/decision/版本/完整payload、slot及同内容成功/未决防重必须同时有效。单事务CAS原recommendation cancelled→pending→intent并建新attempt和幂等关联；旧attempt永久保留cancelled，原推荐编号/UUID/decision不变。重复同继续命令返回同一新attempt，失败整体回滚。此方法只准备，不发送；编排接线和整链正例仍须TASK-013验证。

`feedback.pendingRequests({eventId?,commandId?})`保留原response，并增加已核验原事件provenance（owner/app/chat/event、原文/来源类型、证据ref/hash及稳定command_id）。013通过公开实例消费并核原文/类型/目标3；不复制反馈校验逻辑。直接用户命令是另一有效来源，不必先伪造飞书事件。定时入口不能产生人工探索。

日期：2026-10-24。执行者：Codex。状态：TASK-012有界实现及审查通过，C2C I3 DONE—ACCEPT；覆盖和限制读取任务卡及交付报告。本说明不证明正式调度或长期运行。

## 投递边界

输入来自011的完整display item。必须核对build_ref/build_hash、payload_hash、UUID/批次/类别/实际版本和最终请求体容量。图片上传、构建成功与投递成功分别记录。成功必须有平台成功依据及message_id；成功不表示已读或喜欢。

沿Schema v3：pending是待发送，intent是发送意图或可能在途，succeeded是成功，failed是明确未达，unknown是结果未知，cancelled_before_dispatch是派发前取消。dispatched_at和独占claim证据区分intent是否已被认领；不另加状态枚举。

发送在SQLite事务外，只允许claim赢家调用一次SDK。平台超时、断连、解析失败、丢响应或claim后崩溃均不能盲目重发。先保存确切平台receipt，再事务归账attempt、recommendation、delivered_content。恢复先核对receipt及进程，缺少可靠证据时保留unknown。已成功ID跨关注/探索、批次和策略共用防重索引。

官方依据：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)，2026-10-24实际读取DOM，页面更新时间2026-04-10。相同uuid仅在1小时内至多成功一条；这不是长期exactly-once承诺。230001表示请求参数错误，明确平台拒绝且无message_id才可failed；未知错误不能推断未达。使用raw SDK单次接口，不启用上层自动发送重试。

精确message_id优先回读本人目标和完整payload。无ID时限定本人chat和原时间窗，完整遍历分页，唯一编号/UUID、目标和完整payload匹配且有ID才归成功。零/多匹配、403、超时、缺页或循环page_token均unknown；零匹配不是未达证明。核实允许跨日，实际成功仍归原批原版本。

## 反馈和人工偏好

本人app/chat/sender固定绑定；不跟随最近p2p覆盖目标。关联以已成功投递内容为准，批次编号、UUID或引用消息必须唯一。裸编号跨批歧义先澄清。多个消息指向同内容时归并delivered_content首次成功recommendation，不改当前反馈归属。

event/current/history/outbox及已处理证据在同一事务。事务成功后才允许发送“已记录”回执。保存失败不标永久去重，不返回成功；回执失败不撤销评价。相同event去重；不同event同评价不新增有效变更。更正须expected_revision或明确当前修订关系一致，迟到乱序事件不能回滚新值。无反馈不认定喜恶，看过独立，不将取消收藏解释成踩。关注和探索按真实推荐类别与实际策略版本关联，统计仍沿005 v0.2，由014实现。

人工偏好沿既有preference_version及current checkpoint。显式子版kind=explicit_instruction，保留父pointer、来源事件和append/remove/replace操作。递归核验父模型根、产物hash、DB一致性和已保存事件；不伪造新模型receipt，不调用模型。显式操作只改指令，保留父hypotheses、counterexamples及支持内容。单次赞踩只保存依据，不覆盖全部偏好。

## 指令与停止

“再来3条”和“探索3条”仅保存待013编排的请求与event关联，不提前建批或回复已生成/已发送。探索只由明确指令产生。启动/打开私聊不触发探索。本轮不实现013正式编排，不启用每日推送；北京时间12:00规则保持。

回执outbox保存独立发送状态、attempt和确切私有请求/receipt证据。unknown只核实，不盲重发；业务已保存时恢复只处理未完回执。停止监听不撤回已发内容。所有私有payload、消息ID、账号标识和凭据留Git外。

## 实际入口与调用

`createDelivery({store,root,owner,targetRef,appRef,transport,now?,currentVersions?})`返回`prepareDelivery(displayItem,expectedGeneration?)`、`sendPrepared(attemptId)`、`reconcileDelivery(attemptId)`及`recover({attemptId,confirmedStoppedRunId,evidenceRef})`。prepare返回的attempt_id是发送/核实的唯一输入；重入已有attempt，不能为unknown重新prepare。明确failed允许重新prepare，但仍须重新通过所有当前许可。currentVersions是编排方提供真实版本的同步回调；未传时复核现有偏好指针、active策略和完整基线/实际成员，不把传入条目版本默认为当前。

`createFeedback({store,root,owner,appRef,chatRef,senderRef,transport,now?})`返回`applyFeedback(event,expectedRevision?)`、`sendReceipt(outboxId)`、`reconcileReceipt(outboxId)`、`queryFeedback(selector)`、`pendingRequests()`和`reprocessUnresolved(eventId)`。root须覆盖display产物引用和本模块私有feedback目录，不能把有效display文件放在不可核验的另一个root。

event含`event_id,message_id,app_ref,chat_ref,sender_ref,text,created_at,received_at,parent_id?`。created_at是平台创建时刻，received_at是本机接收时刻，不能混用。解析失败的旧事件可显式reprocessUnresolved；它保存关联原event的新解析修订，保留旧澄清，不重计已保存业务。平台历史回补须有真实平台来源、固定目标/成员、完整范围、原消息ID/时间及可追溯source_evidence_ref；不能伪造成新收到的长连接事件。

文字例子：`1赞`或`1 赞`、`查询1`、`更正 1 踩 修订1`。其中1只在唯一内容时有效；跨批歧义须用完整UUID或`批次UUID/1`。也可引用原投递消息发送“赞”。纯文字且无标题/图片/链接的飞书post按原文字解析，其他富媒体输入不猜评价。赞/踩/看过改值都要求明确更正与当前修订。`修改偏好：少看营销`追加指令；`删除偏好：旧指令`、`替换偏好：旧指令 => 新指令`是明确操作。缺有效父版仅记录待处理，不伪报生效。

`createFeishuTransport({client,targetRef,appRef,root,now?})`返回send/lookup。client是已配置本人应用的官方Client，使用有限单请求超时；SDK连接凭据由调用方私有配置提供。`createFeishuListener({Lark,wsClient,feedback,appRef,chatRef,senderRef,onResult?,now?})`返回start/stop；使用调用方注入的官方WSClient，不自动建立正式任务。stop等待在途handler，不撤回消息。保存失败让官方SDK失败ACK，已存但回执异常不重计业务。

最小调用顺序：011 buildBatch释放槽 → prepareDelivery → sendPrepared → 必要时reconcileDelivery → listener.start → applyFeedback事务 → sendReceipt。恢复已保存业务时只调用未完outbox的核实或发送，不重新发布评价。未知outbox不重新send；先reconcileReceipt。只依赖state文件存在不能判成功。

平台本轮还观察到post回读会补`style:[]`和`content_v2`，只忽略空style缺省字段，保留非空格式差异及完整正文/图序/链接比较。消息历史page_size最大50由本轮API字段校验实际证明，不能以100请求失败冒充零匹配。

有界测试脚本位于本机Git外` .codex/private/task012-live.mjs`，不是正式调度入口。最终验收结论及限制仍读取任务卡与Review报告。

## 成功证据与核实恢复（C2C I1修复）

已归账投递的receipt必须与最终状态、message_id及数据库证据引用一致。旧unknown receipt不能替代后来查询成功的receipt。成功证据损坏时保留历史账和成功防重索引，报告evidence_unverifiable，不重新发送。

回执outbox的历史succeeded也不能单独证明当前证据完整。结果checkpoint缺失或hash损坏时，reconcileReceipt按原消息提示和唯一outbox正文查询。查实后补证据；无法查实时报告evidence_unverifiable并保留历史状态。sendReceipt的终态路径同样核验，不产生第二次发送。

回执在SDK调用后崩溃而遗留intent时，核实零匹配、权限故障或超时只表示unknown。恢复通过revision CAS持久化unknown，并在同一事务保存检查时间、原因和证据checkpoint。关闭并重新打开SQLite后状态仍保留。成功投递、已保存评价和评价历史不因此重做。
