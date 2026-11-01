> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-010 候选运行契约

日期：2026-10-23。执行者：Codex。状态：接口实现、Architecture Review及本卡交付范围通过，实际提交见Git。依据technical-spec §4/7/10、TASK-010。S3；已授权真实登录页面/订阅分析按S4边界。

## 输入和来源
沿用Node24标准库及v3数据库。`createHomefeed({store,root,owner})`创建首页来源编排。`beginBatch({kind,commandId?,explicitRequest?})`区分关注日批10、追加关注3、探索3；这里explicitRequest是明确触发的布尔确认。筛选run另传实际请求文本及探索direction，不由beginBatch保存方向。追加和探索必须有明确请求及稳定commandId。初始化、启动和打开私聊均不创建探索批次。

`refreshHomefeed(batchId,tab,options)`只读调用方已绑定的登录首页。tab为现有受支持浏览器对象；本轮用户明确允许lite ego。模块不建立浏览器连接、不读取Cookie、不实现采集协议。首次刷新与恢复、逐页观察及可靠ID锚点分开记录。仅首页来源，不主动搜索、作者主页或固定手工详情URL。

追加关注及探索的同owner/commandId/请求类型重放返回原批次，包括进程重启后；同commandId类型冲突拒绝，不建新批。

每页证据保存到私有root；来源页面、发现时间、读取方法、完整访问URL、作者、内容ID、媒体提示、分页锚点、成功推进及覆盖范围均可追溯。DB只保存引用及可靠身份。`content`和`candidate`写入不生成收藏观察。不能把标题或摘要当原帖正文。

同一delivery_batch_id累计最多200个唯一平台内容ID，权威计数来自DB。重复URL参数不会新增候选。连续3次成功推进没有新ID、明确页面结束或达到200时停止。故障不是结束或无新ID次数。恢复沿用预算、停滞次数与锚点，不静默重置；扩大预算不在本卡实现范围。

## 材料和分析
候选材料通过008的`ensureMaterial`取得及核验；`recordDiscovery/resume(collectionBatchId)`属于收藏语义，不用于首页。008 claim期间保存候选材料run引用，释放后才调用009 `run({materialIds:[id],batchKey,summarize:false})`。筛选不发布偏好。

正文和媒体需hash、有序关联、解码、业务成功及回执支持；视频只分析已取得正文与封面，保留video_unread。失败、缺图、正文不足和分析partial不能当作完整成功缓存。旧有效产物复核后复用，不因换偏好或策略重采。

## 筛选与比较
从009当前有效偏好指针及不可变版本读取偏好；用户明确指令优先。注册明确active策略，不能把存储初始unconfigured视为已生效。baseline引用实际取得的收藏/成功投递材料，披露本地覆盖和未读范围，不能声称用户全部知识。

先按可靠内容ID过滤已收藏及跨类别/批次成功投递；外发intent或unknown单独hold，交012核实。预检尚无analysis时仅保存候选状态与检查点，不伪造decision所需analysis_id。相同主题或不同ID均不能直接决定信息增量。

筛选复用009官方订阅CLI执行器，增加显式schema/prompt/payload参数，不另建模型系统。冻结候选分析、可追溯原文证据、baseline、偏好、策略及请求。模型输出是待验证的比较提案。代码核对候选片段、基线定位、具体新增种类、比较覆盖及版本一致性后归约gain/no_gain/undecidable。

gain须具体指出新步骤、参数、实测、方法、不同问题或有证据观点。no_gain须说明等价信息，不能仅因关键词相同。引用不匹配、媒体/正文不足或比较无法完成为undecidable并hold。主题相同但有实质增量可保留。探索可为陌生领域，必须依据当前明确请求，不能把关注结果换标签。

当前策略010-v2：相关性引用可为所选直接证据的非空连续原文，保留完整证据和索引；不做模糊、标点或文字归一化匹配。增量comparisons仍完整复制对应候选证据。该变更使筛选指纹失效，只重筛，既有采集和分析不失效。

输出候选的eligible/reject/hold及简短依据。部分材料和比较限制按实际披露。模型自评/筛选分数不证明95%认可；语义质量、真实供给和反馈验收仍属016。

## 缓存、状态及恢复
每候选保留内容与材料版本、实际分析版本、偏好/策略/baseline版本、请求类型及批次、当前阶段、输出位置、结果/原因与下一步。每次外部调用前先保存intent和检查点，后保存receipt，再归账。来源、失败、中断和未知状态不删除。

分析缓存由009按实际输入核验；筛选缓存另含材料/分析hash、baseline成员与证据hash、偏好、策略、请求/类别及比较契约。未变复用，变更只重做受影响阶段；新decision追加，不改旧历史。candidate eligibility只作当前投影。

成功采集receipt未入库时，按候选确切attempt补归账；无receipt和进程/结果不明保持待核实，不能扫描全体历史或重新启动。009额度/认证/未知失败立即停止后续模型调用。恢复先核对实际文件、数据库、进程及snapshot，只续未完成或失效项。不买额度、不切付费API。

新日批只关闭旧候选可执行队列，保留候选/decision、材料/分析、已投递和unknown记录及恢复证据。批次关闭不等于内容删除。候选生成或入选不创建投递成功，不发送消息、不实现展示/反馈/调度。日常时间保持Asia/Shanghai12:00，本卡不部署计划。

## 本地入口与定向恢复

`node src/candidates.mjs run <private-config.json>`处理指定批次的已保存候选。配置必须有db、root、owner、collectionRoot、analysisRoot、batchId；工具路径使用cliExecutable/settingsPath及既有订阅executable/proxy。maxCandidates约束本次处理量。配置与运行目录放在Git忽略的private目录，不在公共说明复制私人地址或设置。

返回status、batch_id、request_type、target、eligible、excluded、held、pending、shortfall和reasons。eligible引用已保存decision；held/pending含当前原因及恢复引用。partial只表示当前实际数量和缺口，不代表目标数量完成。输出不生成投递或成功推荐记录。

run结束原子保存结果文件，返回report_ref，并写独立批次检查点。没有比较decision的已知分析/媒体hold另存带版本、材料/分析ID及输出位置的快照，并事务更新candidate和候选检查点；未决采集/筛选attempt身份不被覆盖。相同输入重入复用该hold，不重采、重分析或重筛。先修复输入不足或实际版本变化，再续受影响阶段。

其余提前hold/reject也写独立candidate_outcome快照及检查点，与当前候选状态事务归账，不改原decision或未决attempt。动态偏好/策略/来源预检每次核对，不能用旧eligible绕过。maxCandidates限制本次覆盖的有序前缀；前缀外候选仍在pending，原因processing_limit。恢复需要扩大已保存候选覆盖时，显式增加本地处理上限；有效结果仍复用。该参数不扩大来源发现预算，不授权追加真实样本。

`node src/candidates.mjs recover <private-config.json> <batchId> <candidateId> <attemptId> <confirmedStoppedRunId> <evidenceRef>`只处理确切候选的既有采集或筛选attempt。先核对进程、文件、最新snapshot和槽；结果未知时不得直接run。已验证成功receipt可补归账；已证明未派发的失败可解除该候选重试限制。恢复成功后仍须读取返回next_step，不将解除重试限制当采集成功。

旧采集回执缺少errno时，单独证明必须绑定attempt/run/candidate/source及原intent、receipt、cli-output哈希，核对原进程已退出、无下载输出且无成功材料，并保存工具修复证据。slot为状态字符串，slot_snapshot可另存完整快照。旧回执不补写错误码、不改成功。其余未知保持待核实。

基线按内容和修复根区分语义输入；同根内择可严格验证的完整物理代表。有效repair可覆盖旧坏副本的物理缺口，但不删除历史，不把不同语义根合并。无有效代表才记录根级缺口。

来源发现由调用方绑定实际页面后调用createHomefeed，不由上述候选CLI自动重连浏览器。后续正式编排留TASK-013。本轮实际结果及最终审查须读取对应记录，本文接口说明不代替运行通过证据。
