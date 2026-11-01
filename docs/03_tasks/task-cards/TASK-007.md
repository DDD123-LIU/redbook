> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../../04_specs/recommendation-count-policy.md)与[最新验收](../../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-007 本地存储与状态基础

## 2026-10-21 本轮执行状态（Codex）

**最终状态：实现、本地验收及审查完成。** 最终39项隔离测试通过/0失败/退出0；独立Architecture Review通过，C2C c2c_007a ITERATION0方案补审及ITERATION2最终Review均实际取得，最终DONE—ACCEPT。F1缺失正文伪成功已实证修复，F2三表原子归账故障回滚已补测，F3 SQL责任已明确，F4文件系统限制保留。实际记录见`.codex/task007-c2c-review-20261021.md`。开发前C2C缺失仍是已获用户接受补审方式的流程偏差，不追认。

只提交本项明确文件；原有`.serena/project.yml`和`.codex/serena-lsp-debug-20261021.md`继续保留原暂存状态，排除在007提交之外。不push/部署/调度启用。TASK-008的007交付依赖已满足，但仍须用户明确指定；本轮不启动008。以下待审状态是补审前历史。

状态：**实现及本地验证完成，Architecture Review通过；C2C规划核对及最终审查待完成，任务未关闭。** 用户已明确指定本轮只执行007。已核对TASK-006封板及Gate3规格范围通过证据；新增`src/storage.mjs`、`src/schema.sql`及`tests/storage.test.mjs`，接口见[存储契约](../../04_specs/storage-contract.md)。最终`node tests/storage.test.mjs`实际35通过/0失败/退出0，包含独立进程并发与崩溃恢复。没有写入、迁移或清空现有私人库。

C2C因连接DNS失败、内置浏览器/Edge目标会话绑定超时、现有连接workspace_info返回Internal error尚未取得本轮规划与Review。独立Sol的Architecture Review不代替C2C。审查门槛未满足，未暂存本轮产物或提交产品代码，不以本地验证绕过交付门槛。恢复入口为`.codex/task007-c2c-pending-20261021.md`→本轮测试及[架构审查](../../05_review/task007-architecture-review.md)。恢复后先补C2C，仅对新发现重测，不重做已通过验证。008未开工且暂不具备完整开工条件。下方未开工描述为封板时历史。

本卡只定义后续实施，不代表当前开工。按编号执行，不自动进入后项；不使用付费API、不增购额度、不接CI、不建设独立网站或App。沿用Node标准库和现有项目生态。

日期：2026-10-21。执行者：Codex。责任：后端。状态：未开工；实施契约随Spec v1.0封板，开工须用户指定。对应规格：[`technical-spec.md` §3—4、§12](../../04_specs/technical-spec.md)。

## 目标与范围

使用Node 24内置`node:sqlite`建立单机单用户持久状态。实现规格§4实体、唯一键、事务边界、schema版本与安全备份恢复。覆盖content、collection_observation、material_version、analysis、preference_version、strategy_version、baseline_version、candidate、decision、batch、recommendation、delivery_attempt、feedback_event/current/history、outbox、sample/report_revision/incident、execution_slot/checkpoint所需字段。仅存私有来源材料的引用和SHA256，不把正文、图片、Cookie或密钥写入Git或日志。

不做采集器、分析、候选筛选、飞书客户端、调度宿主或UI；不迁移/覆盖现有私有库，不删除历史证据，不预先实现后续任务。

## 输入、接口与输出

C2C架构F1/F5修订：实现Spec§4.1的部分唯一日批索引、跨类别成功内容键、实际外键/CHECK、带旧状态及revision的条件UPDATE、槽owner/generation/stop CAS、反馈事件/current并发保护。隔离SQLite必须实际拒绝非法写入和过期代次；rowcount0是拒绝，不冒充已保存。持久投递仅pending/intent/succeeded/failed/unknown/cancelled_before_dispatch；旧别名只在入口映射，blocked等为操作结果。012/013/014的写入责任不得由007重复实现。

输入：Gate3封板的`technical-spec.md` §4实体字段及约束；后续任务只能经007定义的状态读写，不互读临时文件推断状态。逻辑接口包括初始化/版本检查、事务提交、查询唯一键、备份、恢复和一致性核验。具体函数名在实现时按项目现有结构确定，不在此假称已存在。

输出：带`schema_version`的本地库；可回滚迁移；一致性备份和恢复证据；字段/键/事务契约说明。UTC时间存储，业务日由Asia/Shanghai计算。SQLite事务不包住网络发送。

## 开工前置与验收

前置：TASK-006通过Gate3，并由用户按编号指定TASK-007；Node/SQLite支持范围在实现环境实查。不得因本卡存在开工。用户已确认的业务范围不重复询问。

本地验证使用Node标准库和隔离临时数据库，覆盖：

- 同一`(platform, content_id)`重复写入不生成重复content；同一平台event_id重复保存不重复反馈。
- `unknown`不得在没有可靠核实证据时转为`succeeded`；核实成功必须保留原attempt、核实证据及状态历史。材料失败不得覆写旧成功版本；同ID内容变化追加版本。
- 发送意图/状态和反馈current/history/event/outbox按规格保持同事务；中途异常回滚，不留下半套记录。
- 并发执行槽只能有一个持有者；旧执行者未确认结束时恢复状态为`recovery_required`，不可自动抢锁。
- 备份可恢复且实体/计数/关键关联一致；模拟提交前崩溃、迁移失败和恢复失败时保留原库并能回退。不得对现有私人库做破坏性迁移。

交付本地验证输入、预期、实际、退出码和证据类型；记录schema差异及回退步骤。由Review检查唯一键、事务一致性和数据不丢失；保存计划证据`.codex/task007-testing-<日期>.md`、`.codex/task007-results-<日期>.json`、`.codex/task007-review-<日期>.md`。使用既有Node标准库方式，不新增依赖、脚手架、CI或伪造运行命令。

## 停止、回退与后续

停止写入前等待当前事务结束，保留原库与备份；迁移失败回滚事务，优先恢复验证过的一致备份。不得靠恢复旧库抹掉平台已发送结果；外发状态须先核实。停止或失败只记录本任务状态，不自动启动008。产品代码提交前只暂存本项确切文件，并通过本项Review。

未决与开工：schema物理约束和备份恢复须本项实现并本地验证，不依赖真实浏览器/飞书或全量收藏。B1/B3/B4按用户已确认方案和边界处理，不再列为006硬阻塞；006规格Gate3已通过，本卡仍未开工，须用户按编号指定。
实施顺序的直接前置：TASK-006。同时必须满足TASK-006与Gate3；技术输入及额外依赖以本卡正文为准。
