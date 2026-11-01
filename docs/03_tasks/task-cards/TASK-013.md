> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../../04_specs/recommendation-count-policy.md)与[最新验收](../../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-013 每日批次、调度与断点恢复

2026-10-25 最终本地Gate（Codex）：任务卡12项验收映射通过；累计I4/I5/I7/I8增量Review已接受，I9原会话独立审查`SCOPE_ACCEPT`、阻塞项0。20/21唯一有限隔离计划实际两轮自动调用一次gate，均exit0、gateCalled=true、expected blocked；同批target20、slot idle、零投递。两线程均结束，appDB仅两run、`next_run_at=null`；第二主PID12472创建于首轮完成后。证据见`.codex/task013-final-gate-mapping-20261025.md`、`.codex/task013-i9-native-readback-20261025.json`、`.codex/task013-i9-c2c-review-20261025.txt`。TASK-013范围验收通过；精确本地提交已完成（提交号用`git log -1`查询）。正式candidate仍disabled，正式runtime和重启后fresh XHS Page未运行/重绑；故本结论不表示生产就绪，不自动进入014/015，不push/部署。

2026-10-25 20点当前覆盖（Codex）：host写前fence P1已修并新增15/15、Sol/C2C I7限定接受；真实隔离host已证明21/p2 binder成功（随后missing runtime阻断），无业务外发。唯一有限原生周期计划20/21已获用户授权并ACTIVE，首轮实际20:07:37.384 gateCalled/exit0/预期blocked、同批/空槽/零计数通过；21轮与真实主进程重启对比仍待执行。原C2C I8当前只审新周期准备修复和首轮证据，不重审已接受代码；完整结论待归档。本卡未最终验收/未提交，014/015不启动；生产日程未启用，每日目标仍11:15。最新入口handoff及task013-periodic2021-first-verdict-20261025.md。

2026-10-25 最新续作覆盖（Codex）：12:50与13:05两次自动隔离补测已完成，实际12:51:39.391和13:13:02.470，均exit0、预期blocked，同一日批target20、slot idle，未新增投递记录。两计划各一条已结束run，最近回读无next_run_at；配置仍ACTIVE。证据见`.codex/task013-single1250-1305-verdict-20261025.md`。仅自动唤起/同批重入范围通过，不能替代正式配置和最终独立审查。009/012来源只读核查已完成，偏好根不相同，012真实发送/反馈链保留；来源选择和正式runtime待决。复用已完成测试，原C2C I5不重发，I6宿主增量待审。日常时间仍北京时间11:15；本卡未验收，不进入014/015，不启用生产日程或业务投递。下方段落为各自时点快照。

2026-10-25约12:53当前（Codex）：用户获知周余7%后明确豁免本轮<8暂停并授权12:50/13:05各一次隔离补测。两个fresh单次计划已ACTIVE，旧两计划仍PAUSED。12:50 probe实际自动于12:51:39.391调用一次exit0，gateCalledtrue、预期blocked（缺supported tab），唯一今日隔离批7fc9f559-83a4-4400-be3b-353ae9ea0109/target20，旧批closed_day保留，slotidle/attempt/outbox不增。第二次预计actual13:09:54，真实同批/最终调度及新helper/host Review待验；生产未启用、正式配置未完成、日目标11:15不变。TASK013不DONE、不提交、不进014/015。原文证据task013-single-20261025-1250-01a17163-7817-7132-a14d-24ded116b91c.json及对应txt；下文旧暂停/未运行记录为历史。

2026-10-25约11:48当前（Codex）：额度实际剩6%后先交接，停止新模型/C2C。原计划和fresh11:45/11:55计划均PAUSED；11:45run因执行prompt残留准备期激活通知条件而未probe，已保存修正但未复验；11:55派发前因低额度暂停。三条自动run均结束、无probe/外部attempt，不能验收宿主门控。日目标仍11:15，TASK013未完成、014/015不放行、无提交。最新记录task013-low-quota-retest-closure-20261025.md与TASK-013-HANDOFF.md；下文补测ACTIVE是此前快照。

## 2026-10-25 今日补测当前状态（Codex）

每日业务门槛仍为北京时间11:15。原11:15/11:30有限计划两run已结束但未调用probe，旧task013-10-25保持PAUSED。用户明确授权今天11:45/11:55各一次补测，新task013-10-25-11-45-11-55已ACTIVE，首nominal11:45/actualnext11:43:18，提前时等待nominal、同日迟到允许执行；UNTIL仅限制名义触发，不是已派发run运行截止。新helper参数解析syntax及两只读preflight通过，无手动wake；实际补测gate/同批/终止待验，生产NOT ENABLED，不进入014/015。下文原计划ACTIVE/无运行的时点记录作为历史快照保留。准确证据见.codex/task013-host-retest-schedule-20261025.md、task013-host-second-run-blocked-20261025.md及TASK-013-HANDOFF.md。

## 当前时间增量（2026-10-25，Codex）

用户已明确将日批门槛及今日非生产 probe 目标改为北京时间11:15，第二次probe为11:30；取代此前12:00/12:15。其余已封板契约不变。验收边界：上海11:14:59为`not_due`，11:15:00及11:16为`due`，业务日仍按上海午夜切换。有限非生产计划`task013-10-25`为ACTIVE；生产计划NOT ENABLED。首个自动运行于11:17:05.9进入、11:19:44以blocked结束，因宿主探针身份元数据目录读取错误而未执行probe，不能视为宿主门禁通过。证据见`.codex/task013-time1115-p2-doc-followup-20261025.md`。TASK-013整体未验收，014/015未放行。

2026-10-25 I4当前（Codex）：跨代继续实现已冻结CC35BD3E/B080FC3F；本轮定向14/14 EXIT0、3syntax0，Sol实现delta SCOPE ACCEPT，两P1已闭合。原C2C c2c_013a I4已完成代码限定SCOPE ACCEPT，限定内无新增代码阻塞；只剩真实宿主门禁和收尾，不重发/不重跑已验代码。整卡未验收、未提交、无业务外发。有限非生产计划ACTIVE；生产计划NOT ENABLED。首个自动运行11:17:05.9—11:19:44 blocked，身份元数据目录读取错误，未执行probe；真实门禁仍未验证。014/015不放行。最新续作先读.codex/TASK-013-HANDOFF.md。下文I3/F4待实现为历史。

2026-10-25 I3后当前（Codex）：原三P1及真实finish一行补丁已获Sol AR和C2C I3限定接受；新I3-F4多轮明确continue可能漏旧代取消proposal，尚需新RED/授权链判断与必要修复。只续这一未完项及独立宿主门禁，不重复已绿测试。I4未发，未提交，真实计划未启用；013→014仍不放行。最新交接与I3原文见`.codex/TASK-013-HANDOFF.md`、`task013-c2c-i3-review-20261025.txt`。

## 2026-10-25 I3 当前进度（Codex）

按交接只处理原I2三P1，已复现RED并修复：历史停止批在其他批静止后仍可明确继续；prepare崩溃恢复后普通入口保持explicit_continue_required；未派发intent保留业务身份并映射合法blocked阶段，unknown不放行。冻结orchestrator 2AEFE466，定向新增及受影响入口10/10 EXIT0。实际命令、源码hash和输出见`.codex/task013-i3-final-focused-20261025.txt`，Serena/过程见`task013-i3-repairs-operations-20261025.md`。旧无影响测试不重跑，0真实业务投递。

Sol当前实现AR进行中，原C2C c2c_013a I3尚未发送；整卡未验收，不进入014/015，不提交。真实12:00及自动迟到再次唤起未验，有限非生产方案见`task013-host-validation-proposal-20261025.md`，没有启用计划。下方日期段落为历史。

2026-10-24 当前覆盖（Codex）：用户明确指定开工并逐项确认五项阻塞处理标准。状态为实施/验收中，未通过。正式采集浏览器按最新指令统一lite ego，取代下文Edge选型，见[ADR-008](../../04_specs/architecture-decisions/ADR-008-lite-ego-orchestration-host.md)。原c2c_013a I1实际PLAN已取得：F1恢复证明、F2取消接线、F3跨批unknown、F4到期blocked批身份、F5命令来源绑定待关闭。Node/SQLite及真实Page API探针成功不代表真实12:00/恢复唤起通过。旧状态段保留历史；不自动进入014/015，不启用生产计划。

本卡只定义后续实施，不代表当前开工。按编号执行，不自动进入后项；不使用付费API、不增购额度、不接CI、不建设独立网站或App。沿用Node标准库和现有项目生态。

日期：2026-10-21。执行者：Codex。责任：后端编排和停止恢复。状态：未开工；实施契约随Spec v1.0封板，开工须用户指定。对应规格：[technical-spec.md §3—4、§10、§12](../../04_specs/technical-spec.md)。

## 目标与范围

实现唯一执行槽、Asia/Shanghai日批、同日补执行与部分续跑、停止/归账、跨日关闭和完整入口重复/并发防重。逻辑入口包括ensureDailyBatch(now)、批次/执行槽原子领取、阶段恢复和停止归账。已确认目标：每天11:15关注批20；当日错过后具备条件时补执行一次；当日中断可续同批未完成项；跨日不追欠；追加关注/探索按明确指令每批3条，探索不自动启动。

不编写自研常驻调度器或操作系统服务，不更改电源/启动设置，不承诺关机运行，不包含008—012内部业务实现。保留TASK-004后移责任：013实现新入口批次/防重/恢复；015做技术集成；016核业务残留。

## 关键前置与契约

**输入：** TASK-012提供的投递三态、recommendation成功ID及unknown核实记录；TASK-007提供的batch、execution_slot、checkpoint事务接口；已选桌面应用宿主接入后提供的Asia/Shanghai触发时刻及当前批次条件。输出为唯一日批、阶段恢复/停止归账和closed_day状态。B1路线已确认，宿主真实触发与页面读取仍由本项实现/验证，不能作为开工前已经通过的能力。

**开工前置：006规格Gate3已通过，仍需用户指定本项。** B1路线已确认，未实测的运行效果由本项实现、015验证；旧后台超时不改成功。恢复入口/周期检查与同批门控须使用受支持能力，若无法满足则回006调整，不开发自研浏览器桥或改为每日人工提示词。

批次键、状态和接口按§4、§10：batch含delivery_batch_id、command_id、kind、business_day、target、generation、stop_requested、status；阶段状态独立为pending/running/succeeded/failed/blocked/unknown/skipped/invalidated。上海当地时间截至11:14:59均为`not_due`；恰11:15及之后为`due`；当日迟到只创建/返回唯一日批；已存在部分批只续未成功项；跨日转closed_day，保留成功/失败/unknown与有效产物，旧候选不再投递，新批刷新首页。明确停止后自动触发不得清除停止标志，只有明确继续才能恢复。

## 验收与本地验证

前置：007—012按依赖提供可调用模块及状态契约；B1路线已确认（运行效果仍须验收）；TASK-006 Gate3和C2C完成；用户指定013。未满足时仅报告阻塞，不实现备用调度。

使用Node标准库和隔离SQLite/注入时钟验证：Asia/Shanghai 11:14:59不触发，11:15:00及之后允许日批门控，当天恢复仅一次补建；并发/重复触发仍一批一个执行槽；同日部分恢复只续未成功项，成功ID不重复发；用户停止后不启动后续阶段，已派发attempt按成功/失败/unknown归账；跨00:00关闭旧批、保留记录和unknown，不追欠，今日批目标重新为20；探索只有明确指令才产生批；进程崩溃后依据checkpoint恢复且不覆盖已提交结果。合成时钟/进程探针与真实宿主触发明确分开报告。

保存阶段状态机、并发/恢复结果与本机前置检查证据。Review特别检查stop_requested与晚到结果、重复触发和跨日事务。计划证据：.codex/task013-testing-<日期>.md、.codex/task013-results-<日期>.json、.codex/task013-review-<日期>.md。不写未存在的运行命令，不新增依赖、脚手架或CI。

恢复入口验收：明确错过11:15后由哪个受支持的再次入口或周期检查触发ensureDailyBatch，并实测当天只建/续一批、成功不重发、跨日不追补。不能假定宿主自动重放错过的计划；若所选宿主不能提供可用入口，返回006调整路线，不用每天人工提示词替代后宣称达到要求。

## 停止、回退与后续

停止后先等执行者确认退出；若状态无法判定则execution_slot进入recovery_required，不自动抢占。恢复从一致备份/检查点继续，不能以恢复旧库撤销平台外发；先核实所有unknown。通过Review后只交付013，不自动启动014或015。

未决与开工：采用桌面应用计划→代理→Edge扩展；真实11:15计划唤起、页面读取、当天恢复和部分续跑由本项实现/本地验证、015联调；不能满足则回006调整路线，不改成每天人工提示词。B1/B3/B4按用户已确认方案和边界处理，不再列为006硬阻塞；006规格Gate3已通过。当前宿主计划运行缺口见本卡顶部最新状态。
实施顺序的直接前置：TASK-012。同时必须满足TASK-006与Gate3；技术输入及额外依赖以本卡正文为准。

2026-10-24 Codex：C2C I2完整收取并保存task013-c2c-i2-review-r4-20261024.txt；PLAN_RECEIVED，execution_output#37。新增三P1历史head继续/崩溃后普通重入/intent非法阶段，均未修；原本地证据有界接受，不重复绿项。下一步只三项RED-GREEN+I3；真实宿主门禁另留。Sol仅窄方案在进行；不提交。
