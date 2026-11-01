> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-013 运行和恢复说明

## 2026-10-25 最终周期证据增量（I9独立审查待收，Codex）

唯一授权的隔离周期计划两轮均已实际自动唤起并各调用gate一次。ordinal 1于20:07:37.384、ordinal 2于21:02:41.063（Asia/Shanghai），两次均exit0、`gateCalled=true`、因无supported tab预期返回`blocked`。同日批ID保持`7fc9f559-83a4-4400-be3b-353ae9ea0109`、target20、执行槽idle、投递attempt/history/outbox为0；状态链`ordinal1.after == ordinal2.before == ordinal2.after`。

原生appDB只读回读显示计划配置仍ACTIVE、RRULE截止21:00上海、`next_run_at=null`且只两条run；next nominal保留13:00Z（上海21:00）是最后名义slot，不是未来实际派发。两行run状态PENDING_REVIEW；两个Codex线程的实际turn均completed、thread idle。两轮完成/终止证据、PID及时区换算见`.codex/task013-i9-native-readback-20261025.json`和两轮原始文件。新ChatGPT主进程PID12472于首轮完成20:08:09后创建（20:25:15.646182），第二快照中不含首轮主PID49888，符合该有限周期的重启判据。

I8要求已落到未来轮prompt并有实际ordinal 2证明：提前派发后按上海真实时钟等待到21:00再调用；调用前刷新首轮terminal和两run SQL身份；按主进程PID/CreationDate独立核验重启。C2C I9对该增量已`SCOPE_ACCEPT`、阻塞0，完整答复见`.codex/task013-i9-c2c-review-20261025.txt`。两次blocked只证明隔离宿主唤起及门控/同批恢复，不能证明正式runtime、采集、模型或投递链可用。正式candidate保持disabled；最终Gate按TASK-013卡片验收契约收敛，不在I9中扩大。

2026-10-25 当前时间增量（Codex）：每日上海日批门槛已改为11:15，取代12:00；本说明其余恢复契约不变。下方旧时间规则按本条覆盖，历史验证结果不改写。

## 2026-10-25 I3 恢复细化（Codex，待独立Review）

明确继续分别核原批历史静止head及全局最新head。其他批已结束不抹掉原批证明；其他批仍活动、原批已有后继、代次或证明变化时拒绝。历史phase按原owner/batch/run/generation及确切checkpoint绑定，不能使用同批其他代记录。

prepare提交后、发送前崩溃，经原投递接口确认取消并收敛执行后，普通日常入口若发现待明确继续的取消项，返回`blocked / explicit_continue_required`，附原run/generation/attempt；不能用新协调head覆盖继续资格。只有明确continue可沿原推荐、UUID、ordinal重新准备，旧取消attempt保留。坏取消证明返回recovery_required。

owner范围核实遇到未派发intent时，业务attempt仍intent，编排phase为blocked并记录原attempt_status/ID。只有原意图和静止执行证明完整、未派发且事务快照未变的确切intent可用于当前blocked编排的窄结束审计。unknown、已派发或执行者状态不明继续阻塞，恢复入口不使用该例外。

本节对应本地定向10/10 EXIT0（task013-i3-final-focused-20261025.txt），当前源码2AEFE466。独立AR/C2C待完成，不能据此称整卡通过。真实宿主验收、生产配置和持续计划均未完成/未启用。

日期：2026-10-24。执行者：Codex。状态：实施中；不是生产启用说明或整卡验收通过。

## 正式路线与薄入口

当前由用户明确选择lite ego，见ADR-008。公开ego-browser nodejs在同一Node进程import `src/orchestration-host.mjs`，调用 `runTask013Host({configPath,source,taskSpace})`。taskSpace来自ego公开运行环境，不跨进程传Page、不另建浏览器桥。

configPath必须为绝对JSON路径，含绝对dbPath/root、稳定owner/appRef/targetRef、正整数taskSpaceId和已有pageLabel。只复用原数字空间ID；不得把ID写成名称字符串以创建新空间。可选runtimeModule必须为绝对路径，导出 `createRuntime({config,store,now})` 返回现有模块配置及真实实例。不能拿JSON路径或空函数假装transport/model/client已装配。

空间必须仍由agent控制，Page必须属于小红书来源；不满足时返回blocked，不自动创建、接管或跳转其他页面。用户接管时停止浏览器操作，用户明确继续后才用公开takeOverTaskSpace恢复。

source仅接受scheduled、periodic、recovery_startup、manual_daily，全部只进同一个ensureDailyBatch。这里recovery_startup表示应用恢复后的普通日常入口，不是授权抢占旧协调者。人工追加/探索及明确继续使用编排器的独立命令接口；定时入口不能传探索、清stop或自动恢复未知执行者。

## 持久状态

每次运行必须使用同一DB/root/owner。不得为了“重新开始”换库、删除检查点或重发成功消息。正式库路径必须在启用配置中明确；本轮隔离探针库不自动升级为正式产品库。外部调用不进入SQLite事务。

北京时间11:15前返回not_due。到期后即使缺运行能力，也保留唯一当日日批及blocked状态。再次进入复用该批；补建日批与续跑原批是两件事。跨日关闭旧日批，保留成功、失败、unknown和有效产物，不追欠；新日批目标20。

停止首先持久化批次stop_requested。停止后不派发新阶段，已派发操作先归账。确认未派发的投递准备记录由原delivery.cancelPrepared取消；已派发、成功和unknown不取消。普通日常入口不清停止标志。

明确恢复必须检查原批、协调头、执行槽、原attempt、进程/receipt与hash证据。缺少退出证明时保持recovery_required。成功产物直接复用；unknown先由TASK-012原入口核实，核实不到保持unknown且不重发。不能用旧库恢复“撤销”平台已发生投递。恢复接口的最终参数及适用测试读取orchestration-contract和本轮Review，未完成实现不作为可运行承诺。

## 本轮已执行的真实探针

在ego Node中直接import原编排依赖和SQLite成功。真实小红书Page在用户恢复登录/视口后reload/evaluate/PageDown成功。两次独立ego进程调用薄入口、使用同一隔离DB及真实Page绑定，均返回相同的2026-10-24日批，目标20、blocked，投递attempt0。blocked原因是该探针没有配置完整运行模块。

结果文件：`.codex/task013-ego-node-probe-r3-20261024.json`、`task013-ego-page-probe-r3-20261024.json`、`task013-ego-host-first-r3-20261024.json`、`task013-ego-host-reentry-r3-20261024.json`。没有材料下载、模型或飞书发送；不能把这些结果写成完整pipeline或宿主自动唤起通过。

后续已在`.codex/private/task013-runtime-probe-20261024/`准备隔离验证用runtime模块，复用现有授权配置引用。ego内成功构造真实SDK、transport、feedback及原六factory，缺省模型走原订阅CLI接口，不填模型名字符串。只构造不执行，实际证据为`.codex/task013-ego-runtime-assembly-r3-20261024.json`。该库不是正式产品库；生产DB/root及完整运行启用配置仍须明确，不能将012任务库直接上位或复制旧库撤销平台投递。

## 计划配置和环境恢复

计划仅准备在`.codex/task013-host-configuration-draft-20261024.md`，当前未创建/启用。日常目标Asia/Shanghai11:15，拟选每15分钟周期检查进入同一门控。应用/电脑退出时不保证运行，恢复后的下一实际周期是否唤起须独立核验，不能假定重放错过的11:15事件；午夜前不足一个周期可能错过当日补建。

离线、登录失效、Page丢失或额度不足时保存准确blocked/unknown及检查点，环境恢复后从支持的再次入口进入同门控。不要伪造成功，不擅自增加OS服务或修改电源设置。真实11:15及宿主恢复唤起仍未验证；若支持能力不能满足，带准确缺口返回TASK-006。
