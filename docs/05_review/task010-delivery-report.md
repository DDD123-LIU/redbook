> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-010 最终交付

日期：2026-10-23。执行者：Codex。结论：本卡实现及有界流程验证通过，按确切清单本地提交；不push、不部署、不进入011。

## 范围与规范
S3实现；已授权真实登录页面和私人材料验证按S4边界。使用using-vibe-delivery-kit、routing-by-risk、ponytail full、C2C、Serena及verification-before-completion；读取架构、测试、Review、任务启动/结束规范。006/Gate3、009交付及已有效证据复用，不重复RDD/PRD/规格封板。无CI、付费API、正式调度或消息发送。

## 运行入口和输出
`node src/candidates.mjs run <private-config.json>`处理指定批次已保存候选。返回status、batch_id、request_type、target、eligible、excluded、held、pending、shortfall、reasons、versions及report_ref。每个有效决定引用材料、分析、偏好、基线和策略；提前待处理结果有outcome快照。入选不创建recommendation或投递成功。

来源由调用方绑定已登录页面后使用createHomefeed/beginBatch/refreshHomefeed；候选CLI不自动连接浏览器。批次类型是daily_follow目标20、additional_follow目标3、explore目标3。明确请求的commandId重放返回原批；类型冲突拒绝。探索需明确请求和方向；关注不混探索，启动程序或打开私聊不触发探索。

准确参数、前缀处理上限和定向recover入口见[运行契约](../04_specs/candidate-contract.md)。当前私有配置为`.codex/private/task010-live-20261023/runtime.json`，数据库同目录state.sqlite；已有结果有效，不需要再次run。诊断可只读`node .codex/task010-status-20261023.mjs`。两条真实hold应保留，不是自动补跑或扩大采集的指令。

## 实际支持与限制
本卡仅验证首页自动发现，完整URL/ID、作者、发现时间、页证据和范围可追溯。搜索、作者主页和手工链接不作为已通过来源。材料交既有008获取、正文/媒体核验，分析复用009；视频保留未读范围，不声称理解完整视频。

ID层过滤已收藏、成功投递、批内重复及不同URL同内容ID；外发intent/unknown保持hold。跨ID内容比较按候选逐条证据与实际可用基线核对；复述no_gain拒绝，具体新增方法/步骤/证据可保留，无法判断hold。基线只代表本地已取得材料，不能声称账户全历史覆盖。真实历史投递表本次为0，相关历史过滤和未知状态用合成数据验证。

输入及版本不变时复用；偏好/策略变化只重筛。同根有效repair不要求重分析。intent/receipt、独立outcome与batch报告保存各自阶段，未知attempt按确切身份恢复。新批清理仅关闭旧队列，保留历史及恢复证据。maxCandidates是前缀覆盖上限，外部项仍报告pending；提高覆盖复用前项，不自动追加发现。北京时间12:00规则不变，本卡不部署调度。

## 验证与复用
最终受影响合成测试42/42通过/退出0，覆盖F1状态持久化、F2请求重放和F3完整pending，见[实际输出](../../.codex/task010-c2c-fixes-local-20261023.txt)。原89项组合及后续窄变更27/28项分层复用，最后没有重跑全套或真实模型。关注/探索隔离、明确触发、20/3/3与不足、零候选、失败、增量三态、未知投递、版本缓存、中断及跨日保留均有合成覆盖，详见[测试记录](../../.codex/task010-testing-20261023.md)。

真实有界链路：lite ego首页自动发现2条→两份材料→两次分析→筛选/待处理落盘。最终0eligible、2hold、缺口20，原因是added_information_kind_invalid及candidate_media_input_incomplete；不凑数、不放宽条件。没有真实探索业务请求，探索只验证合成规则。正式20供给、陌生领域真实探索和认可率留后续任务。

重复运行0新attempt，旧文件、原009库及旧材料hash不变，偏好1版、收藏观察4、0推荐/投递、槽stopped，report_saved=true。另只读核对包含hold的决定ID和快照一致。见[真实重入记录](../../.codex/task010-live-results-persisted-20261023.json)及[保存结果核对](../../.codex/task010-saved-reuse-check-20261023.json)。最后三项修复后只做受影响合成回归，不重复真实工作。

旧009有效分析复用；仅对原有另一份尚未分析的材料首次定向分析作为比较基线，不全量分析、不重发偏好。首次CLI缺失失败、原unknown回执及独立证明均保留；同版本工具修复后精确解除失败限制，不倒填errno或改旧回执成功。中断后的文件/DB/进程核实与精确续作均留操作记录。

## 工具与审查
C2C I0开发前审查及I1核心核查复用；I1三项发现修复后，I2实际`DONE — ACCEPT I2 FIXES`，独立读取执行输出ID30及当前差异。见[I2原文](../../.codex/task010-c2c-review-i2-20261023.txt)。[Architecture Review](task010-architecture-review.md)通过，ADR-004接受，无剩余本卡阻塞。

Serena实际initial_instructions、项目激活、符号及引用调用已记录；LSP空引用以rg补充。sequential-thinking、shrimp-task-manager和code-index不可用，改用本地计划、Serena/rg并记录。内置浏览器导航失败且未发送时，按用户指示切lite ego；旧空间消失时恢复同任务和原对话，先核对请求，不重复提交、不操作收藏页面。Sol最后一次复核capacity失败和执行代理quota中断如实保留，未冒充通过；最终由本地测试与C2C I2补齐，不切付费API。

## 交付和后续
私人正文、媒体、配置、凭据及下载器均不进Git；原两项Serena暂存及其他任务不纳入提交。确切路径见`.codex/task010-commit-paths-20261023.json`；最终差异、资料排除及证据hash检查见`.codex/task010-final-verification-20261023.json`。提交号以本轮Git记录为准，避免文件自引用提交hash。

TASK-010本卡没有未完成的实现或审查项。现存两条hold及真实供给/质量限制不是已解决业务内容，也不增加本卡关闭门槛。010对011的实现交付依赖满足；011仍需用户另行指定。本轮提交、报告后停止，不自动实施展示、投递或调度。
