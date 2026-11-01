> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-006 首期整合技术规格

2026-10-29，Codex，用户最新规则：[正文优先推送](text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

2026-10-24 用户明确确认的路线增补（Codex）：正式采集统一改为lite ego，取代下文2026-10-21的Edge选型。使用桌面应用计划→代理→公开ego-browser nodejs→同进程原编排器/Page，见[ADR-008](architecture-decisions/ADR-008-lite-ego-orchestration-host.md)。此为显式授权的选型变更；旧Edge证据保留历史。运行时和Page探针已取得，真实定时唤起、再次入口及整链须分别验收，不预先通过TASK-013。当前每日时间门槛见下方最新规则。

日期：2026-10-21。执行者：Codex。版本：v1.0。档位：S3，账号及外部操作按S4边界。

实施映射补充（2026-10-24，Codex）：TASK-012的§4/§9/§12具体调用、状态和恢复入口见[delivery-feedback-contract](delivery-feedback-contract.md)及[ADR-006](architecture-decisions/ADR-006-delivery-feedback-recovery.md)。沿既有Schema v3，无迁移/新依赖；evidence_unverifiable是接口核验结果，不增持久状态枚举。Gate及真实覆盖以TASK-012和交付报告为准。本补充不实现013编排或014统计，不改005规则。

**状态：已封板，Gate3通过（已确认边界内的可实施规格）。** B1路线、B3/B4受限方案已获用户逐项确认；原C2C三阶段及ITERATION3增量审查均已取得，发现已处理。没有将用户确认当作真实能力通过；运行与质量未验证事实和后续验收完整保留。本轮不启动TASK-007。

## 1. 权威范围与证据等级

2026-10-25 用户明确将每日北京时间门槛改为11:15，取代此前12:00；当天恢复补执行、同批部分续跑、跨日不追补、过滤无信息增量内容等其余契约不变。旧实验保留原时间和原判断，不追溯修改。无总运行时限的既有确认仍有效；3分钟只是效率期望。只做小红书和本人飞书，不做独立网站或App，不使用付费AI API，不增购额度。

标记含义：**已确认**=用户业务选择；**已验证**=有本地或真实证据且仅限所列范围；**受限**=明确边界；**待定**=缺决定或能力证据；**设计**=本轮系统提案，尚未实现。设计不得冒称用户逐字确认或运行通过。

- E1：TASK-001局部收藏、增量、恢复、停止证据，见[前置核对](../05_review/task006-prerequisite-evidence.md)及`.codex/task001-final-closure-20261016.json`。全量覆盖获准留016，不能重设为当前分析门槛。
- E2：TASK-002官方订阅CLI图文小批、结果复用与中断恢复；`.codex/task002-review-20261016.md`。无长期额度/产能保证。
- E3：TASK-003飞书双向、保存后回执、未知查询、6000字符/3图样本、视频封面入口，见[飞书报告](../05_review/feishu-feasibility.md)。真实、合成和用户客户端确认分开。
- E4：TASK-004首页一候选、正文9图、独立图文分析、真实send1/upload9与回读7/7是分段组合证据；`.codex/task004-no-cap-chain-results-20261020.json`。30/30为本地合成；后台真实页面读取未通过。见[004收尾](../../.codex/task004-scope-closure-20261021.md)。
- E5：TASK-005业务三项已确认、43项合成通过，见[质量规格v0.2](feature-specs/quality-feedback.md)。真实质量和样本目标留试用。
- E6：本轮Sol架构推理和处理记录见[Architecture Review](../05_review/task006-architecture-review.md)。不是C2C或实际能力验证。

## 2. 技术选型及运行边界

设计：单机单用户，复用Node24标准库、`node:sqlite`、现有XHS CLI、官方Codex CLI订阅登录、已安装飞书Node SDK。数据库一个，业务执行槽一个；不建自研采集协议、通用插件框架、消息队列或微服务。SQLite已有E4隔离探针证据；持久产品库在007实现，不能把探针当成实现。具体ADR见[ADR-001](architecture-decisions/ADR-001-local-state-and-boundaries.md)。

已有三个复用参照：004探针的日键/SQLite事务/恢复、003反馈原子保存和unknown核实、005质量状态算例。它们是契约与验证参照，不复制私人原型或硬编码旧绝对路径为产品入口。

2026-10-21用户已确认路线：桌面应用本地计划唤起代理，代理通过受支持的Edge扩展入口读取已登录页面，再调用现有采集、订阅分析及飞书工具。运行前提是电脑及应用运行、项目可访问、网络/Edge扩展/登录/站点访问/订阅额度/飞书权限可用。恢复后的再次入口或周期检查由013接入同一日批门控，015验证；不假定宿主自动重放错过的计划。该选择明确实施路线，不证明真实12:00/后台页面读取/恢复效果已通过；旧两次超时保留。路线在013/015无法满足时回006调整，不默改每日人工提示词。本轮不创建、部署或启用计划，不提供未经核实的配置或命令。Windows任务+独立CLI不作为当前已选路线。

来源材料保存在现有Git外私有区，库只关联文件和指纹；凭据沿用已有私有配置，不入Git或日志。正文/图片分析会发送给OpenAI，展示会进入飞书，不能称纯本地处理。留存默认不自动删除成功材料、投递、反馈和核实历史；停止不撤回已发内容。后续扩大账号/数据范围须另有明确授权。

## 3. 模块、方向与公共结果

```text
11:15 / 当日恢复 / 明确指令
              |
              v
      [013 批次与执行槽] ------> [007 本地事务/检查点]
              |
  [008 收藏发现+采集] -> [009 图文分析+偏好版本]
              |                    |
              +--> [010 首页新候选+筛选去重]
                                  |
                          [011 飞书B式格式]
                                  |
                          [012 发送与核实]
                                  |
                 [012 反馈先保存后回执] -> [014 质量与策略]
                                  |
                         新偏好/策略版本 -> 后续筛选
```

编号为实施责任，不要求一责任一文件。所有模块依赖007存储契约，不互相读写临时文件推断状态。013编排普通函数，外部调用不在SQLite事务内。009只产出不可变分析/偏好；014产出策略/质量报告，009不调用014，因此没有运行时循环；初始化策略由007保存其版本结构，后续014管理实际变化。

所有接口采用普通函数的逻辑契约，不新建远程API。通用返回必含`status, entity_id, attempt_id?, evidence_refs[], error?`。错误含`code, stage, retryable, observed_at, detail_ref`，不携正文/凭据。`blocked`表示条件缺失；`failed`表示确知失败；`unknown`表示外部结果未知；不能互换。时间保存UTC绝对时刻，展示及业务日统一`Asia/Shanghai`。

## 4. 数据、标识与事务

2026-10-22 TASK-008物理修订（Codex）：Schema v2按ADR-002显式区分同H的物理repair记录。`repair_of_material_version_id`只能指同内容/H/媒体/完整性的普通成功根；`artifact_hash`是独立产物引用指纹，普通去重及原内容hash算法不变。修改因旧成功引用损坏后无法按原唯一键登记补采成果，已交C2C ITERATION1及Sol审查，非静默推翻封板业务规则。显式v1→新路径v2须先备份，不改原库/材料。当前接口详见storage-contract/collection-contract；009后续须按同根/H及实际分析输入复用，不因repair物理ID改变重跑分析。本轮不启动009。最终实现验收见TASK-008。

2026-10-21实施映射（Codex）：TASK-007的物理字段、普通函数、revision/CAS及备份使用说明见[存储契约](storage-contract.md)。这只解释本节的实现映射，不更改TASK-006封板的业务规则或Gate3结论；007本地39项、Architecture Review及实际C2C方案补审/最终Review已通过。开发前C2C缺失作为流程偏差保留，不追认；008仍待用户指令。

以下均为设计契约；字段在007实现并做约束测试。ID用标准UUID；来源`content_id`用平台可靠ID，禁止用标题猜测。来源URL的query不是身份，却可能是访问必需参数，私有保存完整URL，不擅自丢弃。哈希用SHA256，只校验输入/缓存，不当作语义增量。

- `content`：键`(platform, content_id)`；`source_url_ref, author_id?, author_name?, source_state, last_observed_at`。作者缺失不可编造，进入材料待补。
- `collection_observation`：`collection_batch_id, content_id, observed_at, membership, evidence_ref`。membership=`present / confirmed_removed / unknown`；`collected_at?`仅来源明确提供时填。`published_at?`、`observed_at`、收藏时间分开。
- `material_version`：`material_version_id, content_id, body_ref, ordered_images[{index,path,hash}], cover_ref?, media_kind, published_at?, fetched_at, material_hash, completeness, evidence_refs`。同ID变化追加版本；失败不覆盖旧成功。视频只封面/正文/入口，标`video_unread`。
- `analysis`：`analysis_id, material_version_id, input_hash, prompt_version, model_requested, model_observed?, output_ref, completion_evidence, status`。hash包含真正使用的正文、图片、提示词及上下文版本；无法观察实际模型就填unknown，不把请求名当快照。
- `preference_version`：`preference_version, parent?, explicit_instructions[], supporting_content_ids[], hypotheses[], confidence, counterexamples[], created_at`。用户指令优先；新长期兴趣须确认，探索获赞不自动变长期关注。
- `strategy_version`：不可变键、父版、实质规则差异、依据、偏好版本、生效点；初始记录存在于007，014负责切换。
- `baseline_version`：已取得收藏/成功推荐材料版本ID集合、覆盖说明、产生时间。不能假称覆盖全部收藏或用户全部知识。
- `candidate`：`candidate_id, content_id, discovery_batch_id, source=homefeed, discovered_at, source_evidence_ref, cursor_ref?, eligibility_state`；source失败保留，不拿固定手工链接替代发现。
- `decision`：`decision_id, candidate_id, analysis_id, baseline_version, preference_version, strategy_version, category, relevance, gain_state, gain_evidence[], comparison_refs[], result, reasons[]`。实际筛选版本不可事后改标签。
- `batch`：`delivery_batch_id, command_id?, kind, business_day, target, created_at, status, generation, stop_requested`。自动关注日批`(owner, kind=daily_follow, business_day)`唯一；明确指令按`command_id`唯一。kind另有`additional_follow / explore / trial`。日批目标10；追加/探索保留原每批3条；明确试跑3条建trial，均不改变质量样本。
- `recommendation`：`recommendation_id, content_id, delivery_batch_id, decision_id, category, actual_preference_version, actual_strategy_version, state, first_success_at?`。编号永久可定位。成功计数按唯一帖子，不按尝试、分段或消息计数。
- `delivery_attempt`：`delivery_attempt_id, recommendation_id, target_ref, payload_hash, intent_at, dispatched_at?, returned_at?, message_id?, status, query_evidence_refs[]`。外发前保存意图；没有`message_id`不造成功。
- `feedback_event/current/history`：平台event_id唯一，含对象、值、接收/保存时刻、业务revision、更正引用、解析/关联状态。current按推荐内容唯一，歧义不改旧值。重复编号指向同内容不增加有效推荐数。
- `outbox`：反馈回执及异常告警待办、对象、业务revision、外发状态及attempt。业务保存和待办同事务。回执发送也分成功/失败/unknown，不盲重发。
- `sample/report_revision/incident`：完全承接质量规格v0.2，成员recommendation_id、类别、目的、纳入区间、目标待约定、cutoff、策略与事件修订、原报告及父修订均保留。
- `execution_slot/checkpoint`：owner/run_id、generation、batch、当前阶段、待处理ID、成功/失败/unknown引用、输入及输出hash、停止标志和最后提交时刻。单业务槽无TTL自动抢锁；旧进程未确认结束时保持`recovery_required`。

事务不变量：发送意图、当前防重检查及推荐状态同事务；反馈current/history/已处理event/outbox同事务；成功归账和成功ID索引同事务；样本报告读取一致快照。文件产物先写临时文件、校验、原子替换，再提交引用；崩溃遗留无引用文件可核对后复用，不能凭存在认成功。数据库外发送永远不与本地状态宣称原子。

### 4.1 物理约束与写入责任（C2C F1/F5修订）

007实施SQLite时必须启用外键，并验证实际拒绝非法关联。content键`(platform,content_id)`唯一；collection/material/analysis/decision/recommendation等子对象外键连接其明确父对象，不允许悬空版本。自动日批采用仅作用于`kind='daily_follow'`的部分唯一索引`(owner,kind,business_day)`，其他人工批靠`(owner,command_id)`非空唯一，不误限制同日明确追加。

成功内容索引`delivered_content`键`(owner,platform,content_id)`，跨关注/探索/策略/批次共用。首次成功推荐为归属，后来的实际重复只追加投递证据并报故障，不新增N。012在成功归账事务维护该索引。delivery_attempt外键指向recommendation；允许多次明确失败尝试，但有unknown时禁止生成同内容新发送意图。写入许可复核与意图写入在同事务。CHECK限制状态枚举，状态迁移使用期望旧状态和revision的条件UPDATE；0行即拒绝过期写入，不能只靠调用前内存检查。

execution_slot固定单例键；owner/run_id、generation、stop_requested和期望状态共同参与条件UPDATE，失配不得许可新外发。反馈唯一键`(app_ref,chat_ref,event_id)`，current键按本人/平台/内容，revision条件更新；event/history/current/outbox同事务，任一冲突全部回滚。更正expected_revision不匹配进入澄清。007须用独立进程/隔离库验证唯一键、外键、CHECK及CAS拒绝；不是本轮已经实现。

持久投递状态统一为`pending / intent / succeeded / failed / unknown / cancelled_before_dispatch`。旧原型别名`confirmed_success -> succeeded`、`confirmed_failure -> failed`、`attempted_unknown -> unknown`只作导入/接口规范化映射，不另建枚举。API返回`blocked / duplicate / clarification_required`是操作结果，不覆盖持久投递状态。012拥有投递/反馈迁移，013拥有批次/槽/停止，014拥有报告/策略；007只提供事务与约束，不重复业务策略。

## 5. 收藏发现与采集接口（TASK-008）

`discoverFavorites(collection_batch_id, checkpoint?)`输入来源页、已有ID/锚点及授权范围，返回`observations[], observed_ids[], coverage, next_checkpoint, state`。coverage必含本次局部范围、总数是否可知、未解释缺口；局部缺席只记unknown，不能推取消/原帖删除。来源明确的取消或用户说明分别留证据，不默认负向偏好。已验E1只覆盖小范围和用户协助重连。

`ensureMaterial(content_id, complete_source_url, existing_version?)`调用现有CLI，返回完整版本或`incomplete / temporarily_unavailable / source_deleted / access_blocked / unknown`。成功必须业务成功数、正文/媒体关联、文件可解码及有序完整性一致；退出0本身不够。原帖删除须可靠来源证据，否则保持不可访问原因unknown。不会把失败当取消。CLI固定settings文件和完整来源URL的历史约束参照E4，不读取或复制凭据。

新增ID处理；旧ID只在人工指定或有可靠变化证据时重新采集。重复输入复用有效产物；同ID内容变化新增material_version、后续必要分析失效。不能为本轮规格重新全量轮巡。收藏、采集、成功投递、看过分开保存。

## 6. 图文分析与偏好接口（TASK-009）

2026-10-23，Codex：实施映射见[analysis-contract](analysis-contract.md)。本轮v3定向移除完整分析输入的唯一限制，改非唯一查找索引以保留损坏旧成功并追加独立尝试；材料hash/repair不变，显式备份新路径升级，见ADR-003。v1→v2入口原义保留。该修订不放宽有效缓存、完成凭据或偏好发布条件；最终验收以TASK-009 Review为准。

`analyze(material_version, actual_inputs, prompt_version)`通过现有官方订阅CLI，输入正文和有序图片附件，输出逐帖证据、主张、可执行信息、缺失与不确定项，以及完成凭据。schema通过、ID一一对应、CLI成功完成事件、输出完整且内容可核对才可标完成。部分输出标partial，额度/认证问题标blocked；不因文件存在就投递。视频未播放不声称理解视频语义。

通用分析仅在相同实际输入及提示版本复用；偏好或策略/基线变化只重做确需的筛选，不重跑有效通用图文分析。跨批缓存重新核对指纹，不沿用旧脚本只看存在的判断。额度中断保存已成功，恢复先核对结果与hash，只续未完成；真实额度错误自动分类尚未验证，未知错误保留原证据并停，不自动购买或切付费API。

`derivePreference(accepted_analysis_ids, explicit_feedback, parent_version)`输出不可变新偏好及来源。分类/权重由系统设计，时间权重只使用可靠收藏时间；缺失时不以发布时间替代。偏好归纳不是95%质量验收。E2为小批可行性，吞吐、长期额度及在途取消仍受限。

## 7. 新候选、筛选与去重（TASK-010）

2026-10-23实现接口映射（Codex）：[候选运行契约](candidate-contract.md)及[ADR-004](architecture-decisions/ADR-004-candidate-evidence-and-recovery.md)。沿用v3，不新增依赖。接口说明不代替实际验收；最终Gate读取TASK-010和本轮Review记录。

`refreshHomefeed(batch_id, checkpoint?)`输入登录首页、批次与请求类型，刷新后由现有浏览器读取可见候选可靠ID/链接，返回候选列表、页面证据、已见ID集合、位置/末端锚点、读取完整性及source_state。发现输入是刷新首页，不是固定手工链接或关键词搜索。正文/图片/作者/入口由ensureMaterial取得；一候选分段证据E4可复用。搜索未证实且当前不作为必要来源，不自研协议。

分页设计：沿现有可读页面按末端可靠ID推进，页面重复不产生新候选。每次记录观察范围与下一锚点。一次批次最多观察200个唯一候选（系统保守默认，不是产能承诺）；连续3次推进没有新ID、页面明确结束或达到200时结束本次发现并报告真实缺额。单次工具故障不计“页面结束”；预算含跨恢复累计，不因重启无限重置。继续同日批可在明确恢复条件/指令下追加一次有记录的发现轮；自动日批不另建第二批。参数待必要试用证据调整，不设全流程总时限。

C2C F3澄清：200是同一delivery_batch_id跨发现轮、恢复和重启的累计唯一ID上限；额外轮只消耗剩余预算，达到200即不再自动发现。若后续确需扩容，必须追加budget_revision记录旧值、新值、原因、时间及适用批次，不能静默清零；本轮不执行扩容。失败调用不增加无新ID次数，恢复成功后从已保存计数继续。

关注和探索共用首页来源；关注按当前偏好，探索按明确指令的主题/扩展方向筛选，不因程序或私聊打开自动触发。首页未提供相关探索材料时报告不足，不把关注内容换探索标签、不自动扩展搜索。任意陌生领域供给能力**待定**；TASK-010来源完整契约保留受限，不能保证每日10或每次3。真实补测只在006先行验证子项内记录，不新建BUILD编号。

`evaluate(candidate, analysis, baseline, preference, strategy, category)`先过滤已知收藏同ID及跨日/类别成功同ID；同ID有外发unknown则hold核实。再评价匹配与信息增量。最新规则覆盖旧ID-only：不同ID并不自动有增量。

增量设计：`gain / no_gain / undecidable`。gain至少给出具体新增证据、步骤、参数、实测结果、不同问题解决法或有依据的不同观点，并引用候选片段及所比较基线。主题相同不直接淘汰；换标题/作者/措辞而信息相同为no_gain。正文/图片未读或无法支持比较为undecidable，该候选hold。只比较已取得的收藏和成功推荐材料，覆盖不足披露而不全局阻塞。内容hash仅用于完整性，不能代替增量判断。

输出`eligible / reject / hold`及reason。no_gain/relevance不符为reject，缺材料/证据/版本为hold。无筛选证据不得发送。此增量接口有可执行定义，但真实可行性和判断质量**未验证**；先用非敏感构造正/反/不确定契约样例，后续有授权才做真实验证，不为了封板重跑旧模型。

## 8. 飞书展示接口（TASK-011）

2026-10-23，Codex：实施映射见[display-contract](display-contract.md)及[ADR-005](architecture-decisions/ADR-005-display-identity-and-receipts.md)。沿Schema v3，011绑定pending推荐UUID、私有不可变追加ordinal与manifest；不创建发送尝试或成功索引。容量、媒体回执、停止保留及确切恢复见实际接口。真实合成API/回读/用户桌面陈述分别记录，最新验收以TASK-011为准。该映射不改变一篇一条、完整原文和012状态边界。

`formatMessage(recommendation, complete_material)`输出本人私聊B式payload、payload_hash、正文/有序媒体映射及原文入口。每篇一条，含编号、标题、作者、原正文、原序图片；视频给封面和观看入口，不默认加摘要/理由。理由追问只使用已有真实筛选证据。

E3的6000字符/3图是合成成功样本，E4的9图是真实单篇样本，两者不能合并宣称6000字+9图或平台上限已测。2026-10-29用户修订：图片失败或图文组合未知时优先发送完整正文，并明确图片未附原因；正文单独仍超出支持范围或缺失时才返回display_blocked。不截断、不改摘要、不擅自拆多条，不假称图片齐全。移动端/视频播放/平台硬上限未验；历史实测保持。

## 9. 投递、反馈与核实接口（TASK-012）

`prepareDelivery(recommendation, expected_generation)`事务复核已知收藏、成功ID、未解unknown、当前偏好/策略/基线、停止标志与日界；保存intent和payload_hash。发送前再次检查停止/槽代次；intent尚未派发遇停止则`cancelled_before_dispatch`，不假记平台失败。

`sendPrepared(attempt)`外部调用一次；平台code0且可靠message_id为succeeded。明确拒绝且能证实未送达为failed。超时、网络断开、解析失败、进程崩溃或回执缺失为unknown。进程恢复时所有可能派发但未完成记unknown；不能因为没记录dispatched_at就断言没发。

C2C F2/F4澄清：派发前检查是最后许可检查，不承诺检查与SDK实际派发之间零竞态。版本/停止/日界发生在检查后而请求可能已交外部时，按原batch和实际decision版本作为在途核实；不倒改归属或盲重发。决策固定材料、分析、baseline、preference、strategy版本；派发前任一相关当前版本变化则撤销未派发许可，旧decision追加invalidated记录，必要重筛生成新decision，不能改写旧决策。测试须覆盖检查后派发前停止/崩溃、派发后崩溃及午夜迟到归账。

`reconcileDelivery(attempt)`先精确message_id回读；无ID时限定本人会话和时间区间，以唯一编号、目标、payload及完整分页证据匹配。完整唯一且有message_id才归成功。403、超时、不完整页、零匹配、多匹配仍unknown；零匹配不是未发证明，不盲重发。跨日/跨版本仍检查旧unknown。不得承诺严格exactly-once。成功即已推荐，不表示看过或喜欢。

`applyFeedback(event, expected_revision?)`输入event_id、来源消息/编号、赞/踩/看过/查询/更正/指令，返回saved/duplicate/clarification_required/save_failed。保存前解析并唯一关联；歧义/未知编号不写评价，不撤销旧有效值。事务提交event/current/history/outbox后才能回执。保存失败不永久标去重；回执失败不撤销评价。重复event不新增历史/计数；不同事件同评价只保存必要去重，不新增评价变化。更正引用旧revision时澄清，不能让迟到旧事件回滚最新值。查询回显已保存状态。

异常告警也先本地保存待办；飞书不可用不声称已通知，恢复后核实/补告警。没有事件不等于用户没评价；接收、解析、关联、保存、回执各阶段独立记录。本人会话绑定沿授权配置，不能沿用原型“最新p2p自动覆盖目标”的缺口。停止本地监听不撤销已发消息或授权。

## 10. 调度、状态与恢复（TASK-013）

**已确认规则，宿主路线已选，运行效果待013/015验收。** 日界为Asia/Shanghai 00:00。11:15前`ensureDailyBatch(now)`返回not_due；恰11:15及之后原子创建或返回当日唯一daily_follow批。机器错过11:15后当天恢复运行只补创建一次；已存在部分批只续未成功项。重复/并发触发不新建批，不重复发送成功项。用户明确停止保留停止标志，自动触发不覆盖其停止意图；再次明确继续才恢复。跨日不创建昨日欠额。

日批目标10；追加关注/探索是明确指令独立3条，不挤占日批，不因打开私聊触发。日批发现不足记录已发数/缺额/原因，有限暂故障自动恢复或明确继续沿同批。非临时不足不无限刷新。人工“开始新一轮”若存在日批不重置该日批；独立10条请求只在用户明确说10/新轮时建manual_follow，命令ID防重；该额外入口不代替日常自动要求。

批状态：`pending -> running -> completed / partial / blocked / stopped`；partial/blocked/stopped在条件恢复或明确继续后回running；completed不再发送。跨日未完成转`closed_day`，仅保留在途核实。阶段状态：`pending / running / succeeded / failed / blocked / unknown / skipped / invalidated`，各阶段独立，不用“批成功”掩盖单条unknown。

跨日：先关闭旧批新步骤，未投递候选从执行队列失效；保留候选历史、成功、失败、unknown、材料、分析、反馈和报告。新批刷新首页。旧内容再次遇见可复用匹配输入的有效材料，但必须按新基线/偏好/策略重新筛选；已成功ID不重发。午夜前已派发而午夜后确认成功仍归原批、另记实际成功时间，不填当日目标，不从样本删除。

单执行槽使用SQLite事务CAS，外部调用前检查owner/generation。恢复不得仅凭超时抢槽：确认旧执行者已结束、核对旧attempt在途与晚到结果后才交接，否则recovery_required。CAS不能撤销已派发请求；不写成绝对不重不漏。

系统设计默认：浏览器读取外层55秒/内层50秒沿E1；CLI采集/模型单次外层各180秒/600秒；飞书请求30秒。暂时网络或明确可重试错误最多初次+1次，等待5秒；429遵守可得Retry-After且本轮不超过2次。它们是待实现可调参数，不是平台承诺。发送unknown不进入普通重试；核实可首查+延后5秒复查一次，仍未知就hold。额度/登录/验证码/权限不足不盲试，保存进度等待环境恢复。未识别额度错误归unknown_error并停止该阶段，不猜恢复时间。无全流程总时限，不因累计超时重置成功。

停止：先持久stop_requested，再不启动新采集/下载/分析/发送。已发请求只核实归账；晚到有效结果保留但不继续下游，unknown不丢弃。用户接受等待停止确认，不承诺固定秒数或底层网络立即取消。恢复先查检查点及有效输出，不重新发送成功或重跑有效模型。

本机离线、睡眠、关机无法保证11:15触发；不修改唤醒设置或承诺关机运行。Edge扩展/浏览器登录/网络/订阅额度/飞书权限均为运行前提，人工协助恢复已获接受，不等于后台自动恢复技术通过。

## 11. 质量、样本与版本（TASK-014）

2026-10-26实施映射（Codex）：014的函数、完整快照、报告修订、权威策略许可与恢复记录见[质量接口](quality-contract.md)。event_revision映射为全局反馈变更水位，报告另存成员和投递历史边界，不更改下方业务规则。当前验收状态读取TASK-014和本轮Review，不把接口文档或方案批准当运行通过。

以quality-feedback.md v0.2为唯一计算定义：N=L+D+E，S为E中仅看过子集，U/F单列；20E<N且20L>=19(L+D)，零分母不通过。关注/探索隔离。unknown未解不能质量通过，不能删除失败或缺失美化。初测全部成功唯一推荐累计，不按批、跨日或换版清零。

`calculate(sample_id, event_revision, as_of)`读一致快照，返回分子分母、缺失原因/证据、U/F、资格状态和报告修订。截止为最后确认成功+48小时；保存时刻恰截止包含，迟到/更正追加修订，原报告和原结论不改。样本目标总量和充分性在016约定，未约定不算通过。

版本切换停止旧未发送候选；必要重筛并留证据才使用新版本，在途保留原实际版本。恢复绑定incident及真实规则变化，最多两个调整版本，新规则新推荐分别验收；技术修复/改名/补一批/跨日不能重置。近7个北京时间自然日、每周日常规Review沿005系统设计；不默认自动停推或催评。

## 12. 本地验证、停止与回退

006只验证文档引用/需求覆盖/字段状态依赖/边界算例，必要可行性与模拟明确分开。旧有效模型批、采集/下载和平台发送不重跑。004已含12点纯函数和合成恢复，可复用；本轮最小边界补验抽取旧`dueBatch/localDateParts`在隔离上下文运行，不执行旧全探针或改历史输出。这不能证明真实12点触发。

007—014各自留本地单元/契约、隔离冒烟、失败恢复及Review，不能全留015；015负责真实获准整链集成，016负责全量/正式10/真实质量与运行观察。禁止CI。验证结果含输入、预期、实际、退出码、证据类型和未验项。

回退：文档用本轮独立Git提交回退，不操作其他任务；产品库迁移前做一致备份及schema_version，失败事务回滚，原材料不删；服务停止后确认执行者结束再恢复库，平台已发不能靠恢复旧库抹掉，所有在途先核实。007须验证导入/备份/恢复；不对现有私人库做破坏迁移。不制造当前不存在的运行命令。

## 13. 需求到任务到验收映射

- F01：§4—6；007/008/009；ID幂等、局部覆盖、删除/取消/失败、内容变化、材料与分析版本；全量016。
- F02：§6—7/10；009/010/013；关注/探索隔离、明确触发、来源不足说明、新长期兴趣确认。
- F03：§4/7/10；010/012/013；12点前/等/后、同日补一次、部分续跑、跨日不欠额、数量缺额；015集成、016正式10。
- F04：§7/9；010/012；收藏/成功ID过滤、unknown保持、无增量/有增量/不确定；覆盖范围披露。
- F05：§8；011/012；完整正文优先、可用原图、图片失败说明、长文/多图/视频边界，图片问题不单独阻断正文。
- F06：§9/11；012/014；保存后回执、重复/更正/歧义/失败、对象与版本可追溯。
- F07：§9—10/12；012/013/015；发送三态、有限重试、停止/恢复/跨日、旧worker/晚到结果、告警待办。
- F08：§11；014/015/016；005全部边界、初测累计、48小时、两版恢复、真实样本充分性及95%双门槛。

任务依赖是实施顺序007→008→009→010→011→012→013→014→015→016；运行模块数据依赖见§3。全部以006和Gate3为开工前置，不能按卡片存在开工。

## 14. 未决项及封板条件

- B1方案已确认（2026-10-21用户第二次回复“是”，Codex记录）：采用§2桌面应用本地计划→代理→Edge扩展路线及其前提，不再以尚未完成真实运行验收阻塞006。真实12:00、后台页面读取、当天恢复和部分续跑由013实现、015验收；失败回006调整路线，不以每天人工提示词替代。旧唤起/枚举成功与两次读取超时分别保留，不记能力通过。B1从路线选择阻塞转为已选方案和后续验收风险，不直接宣告006封板或Gate3通过。依据见[路线复核](../05_review/task006-b1-route-recheck-20261021.md)及`.codex/task006-blocker-confirmation-20261021.md`。
- B2已关闭：本轮c2c_006a规划、关键架构与最终草案审查均实际取得；F1—F5及最终R1/R2已核对处理。最终为`DONE — FINAL DRAFT REVIEW / TASK006 NOT COMPLETE / GATE3 NOT PASSED`，不拿旧005或Sol替代。详见`.codex/task006-c2c-review-20261021.md`。该次审查是确认前时点，B1现已完成方案确认；本项不再列阻塞。
- B3不作为006封板阻塞（2026-10-21用户明确回复“是”，Codex记录）：§7已定义比较基线、判断证据及gain/no_gain/undecidable。010实现并验证判断流程，016检验真实推荐质量；undecidable候选hold，不冒充合格或直接投递。尚未实现/真实效果未验的事实保留，旧ID-only证据不作为新增量判断通过依据。此确认不改变过滤要求、不关闭后续验收，也不直接通过Gate3。
- B4不作为006封板阻塞（2026-10-21用户明确回复“是”，Codex记录）：采用现有首页推荐流，不承诺覆盖任意指定主题。010实现连续发现，015验证整链，016检查真实供给；保留每日10条目标，不足报告实际数量和缺口、不凑数。探索无合适内容如实说明，不将关注内容改标签；探索仍只由明确指令触发。原单候选证据不重测，连续发现/探索供给尚未验证的事实和后续验收保留。本项确认不证明每日充足，也不直接取代最终规格/Gate复核。
- 非006阻塞：收藏全量覆盖、正式20、真实质量/样本目标及长期产能仍按已授权016验收；新入口普通实现/串联恢复/并发由013实现、015验证，不能把全部一概后移016或冒称已验。

本轮完成可实施规格及任务契约收敛；C2C ITERATION3确认在用户明确边界内通过规格门禁，R3旧继续入口、R4旧末段及R5宿主输入文字已同步。Gate3逐项判断见[Gate评估](../05_review/gate-assessment.md)。通过不代表真实12:00、后台读取、完整恢复、每日供给或推荐质量通过；它们仍按后续卡验收。仍须下一条TASK-007指令才开工，本轮停止。
