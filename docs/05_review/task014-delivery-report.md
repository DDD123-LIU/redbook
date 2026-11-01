> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-014 质量统计与策略版本交付记录

日期：2026-10-26。执行者：Codex。档位：S3。最终状态：TASK-014任务卡范围验收通过。原C2C I3实际复审`DONE — DELTA PASS`，I2唯一P1关闭；Sol对应代码/回归闭合，Codex映射自审通过。CD980A7E冻结版六文件38/38通过；下方101/101为7246冻结版有效整合基准，按未受影响范围复用，不与38重复计数。只按确切清单本地提交，提交号以Git/最终回复为准，不push/部署。

## 实现及边界

新增`src/quality.mjs`，提供样本登记、calculate(sample_id,event_revision,as_of)、不可变报告修订、监控视图、周常规Review记录、策略生效许可及恢复事件。沿用Node标准库、schema v3和007同步事务，没有新增依赖或隐式迁移。

候选、展示和投递共享当前策略许可，旧currentVersions不能绕过；已claim的旧版请求仍按原版归账。投递归账的状态历史和成功索引使用同一确认时刻，原发送时刻独立保存。未实现新的推荐筛选、投递、反馈接收或自动停推。

## 验收映射

- 两类独立N/L/D/E/S/U/F、整数双门槛、零分母和样本目标：quality/boundaries测试；原始分子分母见`.codex/task014-boundaries-results-20261026.json`。
- 重复反馈、更正、仅看过、保存时间及全局事件水位：已保存history重建，不用当前值冒充历史。
- 48小时、活动截止推进、纳入关闭、长窗口多次成功、迟到补核：quality/boundaries/final-ar。旧报告和原按时结论保留。
- 完整快照、partial水位、historical/current隔离、原报告hash、失败事务回滚和数据库重开：quality/replay/ledger。
- 成功内容唯一归属、失败单列、unknown及窗外/未dispatch排除：boundaries/replay/final-ar，不拿未知直接通过。
- 实际策略不可变、同父并发一胜、物理键/hash/父链拒绝、旧候选和回调权限：ledger/permit及候选decision事务竞态。
- 最多两次真实规则调整、规范incident根、旧评价归属、合法旧材料重筛、两轮失败耗尽、迟到green不翻旧结果、换名/新报告/重开不重置：boundaries/final-ar。
- 上海最近7个自然日及周日Review的本地记录：ledger。没有部署日程、外发告警、自动停推或催评。

## 验证及Review

冻结quality源码SHA256为`7246A0049429446AB274D388B387A847A1F36844F98718D6FC0222B2EFFEF5DE`。9文件相关组合101/101，失败/跳过0，退出0；补充候选decision事务竞态1/1、退出0。两者分别留证，不重复计数。输出为`.codex/task014-final-validation-r2-20261026.txt`及`task014-candidate-final-validation-r2-20261026.txt`。TASK005既有43例复核复用，未重跑。

I2唯一P1修复后的最新quality SHA256为`CD980A7E633185469B51C194079ED174253AD348508F4D483DF0CCEF5B55118C`。正式事实边界E=max(纳入关闭C,反馈截止D)，D仍最后确认成功+48h；成员/投递按E、反馈按D独立重建。root受影响六文件38/38、0失败/跳过、exit0，输出`.codex/task014-i3-validation-20261026.txt`；新增晚首算/渐进等价与D<C、U和更正边界均通过，其他有效证据按范围复用。

开发前C2C I1批准方案；实现阶段各Sol发现与DELTA-AR1均留复现、修复和正确预期回归。I2发现晚首算反例，经C/D/E裁定修复、永久回归和Sol单点复核，最后闭合记录为`.codex/task014-i2-cutoff-closure-20261026.md`。原会话I3实际通过MCP核源码、测试及execution_output ID47，明确`DONE — DELTA PASS`、I2唯一P1关闭、限定范围无剩余阻塞。可见答复及终态证据归档`task014-c2c-review-i3-20261026.txt`；页面正文尾部在“合法D”处提取截断，已记明只含可读取部分，没有补造协议尾文。该显示限制不覆盖或否定已可读取的明确结论、MCP读取事实及38项证据。

## 未验证及交付限制

全部新增验证均为隔离合成数据。真实试用目标、每类恢复充分性及推荐质量留TASK016，不宣称真实认可率达标。不涉及真实账号外发、重新采集/模型分析、CI、生产日程启用、push或部署。TASK015未执行。

准确停机/恢复及完成记录见`.codex/TASK-014-HANDOFF.md`。本地Gate依据任务卡逐项契约、实际验证和独立Review判定，不以自评分代替证据。后续只在用户另行指定时执行TASK015。
