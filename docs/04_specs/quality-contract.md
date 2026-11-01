> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-014 质量统计与策略记录接口

日期：2026-10-26。执行者：Codex。业务定义唯一来源：`feature-specs/quality-feedback.md` v0.2、`technical-spec.md` §4/§11—12。本文件解释实现接口，不更改门槛、类别、反馈语义或试用总量。当前实现和最终验收结果读取TASK-014及本轮Review。

## 入口和数据来源

`createQuality({store, owner, now?})`使用007的同步SQLite事务。`store`须为已打开的项目库，`owner`必须明确。`now`默认返回UTC绝对时间；隔离测试可注入时钟。模块不发送、接收、采集、筛选或自动停推。

`registerSample({sample_id,purpose,category,included_from,included_until,target_total,strategy_version?,incident_id?,preference_version?})`登记样本。purpose为initial、monitor或recovery，category为follow或explore。时间必须带时区。目标或范围未约定时保留null并报告待定。新initial/recovery须事前登记；同一声明重入沿用原登记时刻，不因时钟前进或跨日另开初测。调用方不能挑选成员。初测累计跨批、跨日和跨策略保留。

`registerMonitorSample({sample_id,category,target_total?,as_of?})`登记最近7个上海自然日的观察视图，包含当天及前6天。该视图明确是历史监控，不冒充事前试用。报告标记当天尚未结束和不足48小时的观察中推荐。

`calculate(sample_id,event_revision,as_of)`在一个同步事务内读事实并保存报告。event_revision严格为`feedback_history.feedback_history_id`全局反馈变更水位，不是每内容revision，也不是整个质量输入的唯一版本号。as_of不得晚于注入时钟的当前时间。

成功成员来自012的首次成功内容归属及其投递证据，按owner/platform/source_content_id唯一。原发送时间与确认归账时间分开。窗外推荐明确排除；从未派发的意图不当作unknown投递。可能已发但边界不可靠的记录保留待核实。失败及unknown单列，不混入N或E。只采用已保存反馈历史，按全局水位、保存时间和每内容业务顺序重建当前值。

## 输出和不可变报告

calculate返回`status/sample_id/reports/metrics/qualification/blockers`。每个报告包含完整成员、类别、实际策略/偏好、纳入区间、目标、截止、事件及投递历史水位、逐内容采用的反馈修订、分子分母、缺失原因及证据。N=L+D+E，S为E子集，U/F独立列出。

报告给出缺失率E/N、一致率L/(L+D)、有效反馈覆盖率(L+D)/N和任何反馈覆盖率(L+D+S)/N的原始分子分母。判定使用整数`20E<N`及`20L>=19(L+D)`。零分母显示暂无数据；无法判定、待定、通过和未通过分开处理。未知缺失原因如实记录，不凭没有本地事件推断用户未操作，也不新增未知原因必须为零的门槛。

`report_revision`只追加，父修订及snapshot hash保留。完整快照包含反馈水位之外的成员和投递归账边界；补核不能因反馈水位未变化而被错误吞掉。相同输入重算返回已有报告。历史as_of查询标记historical，不使当前报告头倒退。

反馈截止D为最后确认成功时刻加48小时，恰截止保存的反馈包含。纳入关闭C和反馈观察均完成后才可正式裁定，最早事实边界E=max(C,D)；这不改变D，也不是新的质量门槛。正式报告按E读取成员/投递unknown/失败，按D读取反馈history，并分别保存facts_as_of与cutoff_at。关闭前的中途deadline不能因晚首算而变成正式结论；渐进计算与晚首算的正式业务结果应一致。

正式裁定前补核成功可推进活动截止；合法裁定边界发生后保留原报告。截止后更正、迟到反馈或成功补核生成带原因和真实时间的新修订，保留旧成员快照及原结论。迟到绿色报告不改写原来的按时恢复失败结论。新成功补核可产生新的观察截止，不能反填原发送时间或静默延长至达标。用于判断新独立失败的实际证据时刻不由新报告生成时间或更晚的纳入关闭时间代替。

## 策略许可和恢复

`readCurrentStrategy(store,owner,at?)`是候选、展示和投递共用的权威许可读取。返回实际策略ID、父版、偏好、完整规则、规则hash、生效时间及ledger引用。无014 ledger时仅允许原有active记录bootstrap；有ledger后，显式旧版本或旧`currentVersions`回调不能覆盖当前头。父链、hash、唯一键或时间有冲突时拒绝许可。

`activateStrategy({strategy_version,parent_version,rules,rule_diff,evidence_refs,preference_version?,incident_bindings?})`在事务内核对当前父头、实质规则变化和恢复额度，再写不可变策略和生效记录。仅改名、相同规则、技术修复、补回执、补一批或跨日不能作为真实调整。失败整体回滚，不消耗半个索引。同ID或过期父头不会重复分配调整索引，调用方先查实际头再恢复。

旧未派发内容立即失去发送许可；候选最终decision事务、展示reserve、prepare/reprepare和send claim各自重核。切版与claim按同一SQLite写事务边界排序。已经claim的旧版在途请求继续按原实际版本核实归账，不改历史标签。旧候选可复用材料/分析，但使用新版必须重新筛选并保存实际新decision及证据。旧成功投递内容不能复制成新版恢复成员。

`openIncident({report_revision_id})`绑定失败截止报告和类别，返回规范恢复根。每类未结束或已用尽的根不能通过新名字、新报告ID、重启或跨日绕过。恢复结束后的新独立失败须有后续实际观察/失败证据；不能用旧失败事实的新报告生成时间伪造新一轮。策略生效事务为受影响的根分配索引1或2；恢复样本只能绑定该占位的实际策略。第1版按时通过则恢复；未通过可调整第2版。第2版仍未通过则本轮恢复失败。样本未完成仍待定，不能写成功或自动新增第3版。旧评价和初测累计保留。

## 记录、错误和验证边界

014沿用schema v3及现有checkpoint主键，不在打开模块时隐式迁移或增加DDL。质量ledger通过确定性物理键、受控追加API、规范JSON hash和父链校验保存。报告写入、样本成员和关联状态处于同一事务；失败保留上一一致快照。错误带稳定`code`，不得把写入失败报成功。

`recordWeeklyReview({as_of?,event_revision?})`只在上海周日保存本地常规Review记录，不创建计划、不发送提醒或告警、不清历史、不自动停推。

验证只用隔离合成数据和Node标准库。TASK-005既有43例是已通过的规格基准，本任务不重跑。真实试用总量、每类恢复充分性及真实质量验收留TASK-016；本接口或合成测试通过不表示真实推荐达标。
