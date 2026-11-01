> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK016 正文试用基线 Task Packet 与窄规格草案

日期：2026-10-28。执行者：Codex。状态：待父任务评审，未进入 Build。S3，复用 TASK016 需求与用户正文阶段接受；本文件收敛新增跨模块路径。Gate 3 尚未通过。

## 目标与关键约束

用户要从当前首页选出10条，投递飞书，评分后可追加3条。已有588条阶段分析，其中585条有文字证据；3340图未读。不得重新分析全部588条，不扩到5498全量，不以导入画像代表筛选已可运行。20是交付目标，不是仅看20个候选即可保证满足的数量。

现有 src/candidates.mjs 的 baselineSnapshot 只用 CLI accepted analysis 且要求完整可读媒体，总JSON不超过320000字节。evaluate 要求每条候选 direct_evidence 与每个基线材料形成唯一比较；任一 insufficient 都 hold。gain 是存在一条候选证据对所有基线都非 equivalent；no_gain 是每条候选证据至少命中一份等价基线。不能用主题相似或不同ID替代比较。

新路径仅声称相对已接受正文范围的新意。不声称相对未看图片、缺正文3条、未采集材料或历史全部收藏的新意。旧生产完整媒体路径保持原样。

## 接口与范围快照

建议 createCandidates 的显式选项增加 acceptedBodyTrial:{preference_pointer,acceptance_ref,scope_ref}，默认 undefined 走原路径。禁止隐式按画像kind切换。scope_ref 为只读冻结文件：kind:accepted_body_trial，schema_version，profile/ledger/acceptance SHA，585个 note_id/material_version_id/body_hash，excluded 三条及原因，images_seen:0，evidence_scope:title_and_body，novelty_scope:accepted_585_text_only。585为本轮输入核验得到的数，不硬编码在通用函数。

buildAcceptedBodyTrialBaseline 从外部画像manifest读取已核验材料与ledger，逐note_id核验原文。保留 title 与完整 description，不只留ledger短引文。短引文用于来源追踪。没有证据材料不参与比较，必须在 excluded 中完整列出。固定基线成员由用户接受材料集决定，不从当前主库589材料宽泛查询，因此历史合成不进入。

基线版本使用 TB- 前缀，覆盖字段明确 accepted_body_trial 与 text_only。input_complete 只能在全部585正文可验证、未篡改后由试用入口内部生成，意思仅是已声明正文范围完整；不得存入旧baseline缓存并冒充media completeness。原body缺失、映射多义、重复ID、来源改变均hold。

候选继续走既有采集与分析，保留实际媒体范围，不伪造外部body ledger为analysis.complete。若候选当前仍必须完整媒体，就沿用；放宽候选媒体属于另一个明确规格变更，本文件不做。

## 分块比较

planBodyTrialChunks(baseline,candidateEvidence) 按稳定材料顺序分块。双约束是序列化请求小于320000字节，以及预计输出比较行数上限。不能仅按输入字节切块：单块含大量短材料也会输出溢出。首轮小规模探测单候选单块验证实际输出长度及耗时，然后确定保守行上限。单条超大正文不可截断；标记hold或另行获准专门处理。分块只拆材料，不拆候选证据索引空间。

每块输入绑定完整scope hash、candidate analysis hash、preference/strategy版本、chunk ordinal、chunk material IDs及其完整正文。块输出复用既有 SCHEMA/comparisons 字段。相关性和指令先单独定稿一次，各块只做比较；适配器把固定的相关性/指令字段加回 proposal，不逐块重复询问以免冲突。可选先用该固定判定拒绝明显不相关候选，从而省后续成本；没有通过完整基线比较的候选不能eligible。

executeBodyTrialChunk 复用 runCodex 的selection参数、schema校验、receipt/hash、执行槽、unknown恢复与checkpoint机制；新增 chunk_id 作为恢复和缓存键。缓存输入必须包含scope和所有版本hash。完成块不重跑；unknown不自动重发。新真实调用仍需遵守用户指定模型与已授权路线。复用CLI代码并不等于已获准改用CLI：若用户仅授权ChatGPT GPT-6，则先实现相同契约的Chat产物取回核验，或取得明确的路线授权。禁止制造CLI completion receipt。

逐块验证引用、成对唯一性、候选证据全集×该块材料全集、无insufficient。可以将局部块交evaluate进行结构验证，但不能据局部eligible或reject作最终决定；单块no_gain与全局不同，局部结果只能是证据，不直接进入候选决策表。

## 确定性汇总与复用evaluate

mergeBodyTrialComparisons 要求所有计划块的scope、candidate、preference、strategy hash一致；材料无重无漏；所有原文哈希再验。连接全部 comparisons，恢复完整 compared_material_ids 和 compared_candidate_refs。

汇总gain_state不再发一次模型请求。按现evaluate的相同逻辑计算：存在候选证据对全部585均不等价→gain；每条证据至少与一份基线等价→no_gain；缺项/insufficient/坏引用→hold。不能采用任一块gain即全局gain，也不能要求每块同一gain_state。

仅在该受限scope入口内，将完整汇总proposal和全585正文基线传入原evaluate。320KB是模型输入单块上限；最终evaluate是本地内存判断，可以处理完整合并数组。最终decision证据记录 TB-scope、所有块receipt/hash和范围限制。缓存、重审和投递前版本检查必须认识这个显式scope，不能恢复时掉回旧完整路径。

投递必须在卡片/批次报告明确“仅与已接受585条标题正文比较，图片未纳入”。交付范围改变前不得把该trial decision自动当全局生产eligible。10条之后的评分和追加3条继续沿用已存在幂等批次、投递、反馈接口；此处不新造投递器。

## 最低改动清单

1. src/preference.mjs：导出可验证外部画像证据读取（从现manifest返回scope/materials/ledger来源），不增加模型完成记录。
2. src/candidates.mjs：显式trial baseline构造；分块计划、块缓存/恢复及确定性合并；原evaluate不改判定；仅提取现selection运行代码供块调用，不另建并行模型执行器。
3. 原本创建candidate流程的runtime入口：透传trial选项并冻结scope；投递前复核及报告显示scope。必须确认现runtime引用链后定位准确文件，不猜文件名。
4. 沿用现候选测试框架，增加范围隔离/错误来源/遗漏块/重复块/跨版本块/局部gain反例/CLI旧路径回归/中断续块/投递scope传递。首个真实块验证通过才扩大候选数量。

## 成本与真实可行性

20候选×585基线=11700组比较；若每候选有E条证据，则输出至少11700E行。E=3是35100行，E=5是58500行。每行还重复candidate_quote、baseline_quote和explanation。分块只能防请求和输出溢出，不能减少总行数、重复输入或模型调用成本。实际候选通常要超过20个才能产出20条eligible，成本还会增加。不能承诺本轮马上完成10条。

先做一个真实候选、一个小块，记录材料字节、证据数、比较行数、输入/输出长度、耗时、失败与额度，再按剩余块数外推。没有测量不报费用或完成时间。若逐对严格比较仍必须保留，这是可实现但较重的改造，不是画像导入后的顺手一步。

只选相关主题基线会降低“相对全部旧正文有新意”的保证：错分主题、跨主题同义内容及未归类材料都可能遗漏。不能自行采用。可以先做相关性过滤以减少候选，但通过者仍与全部585比较。若用户明确接受“仅对检索到的相关主题材料去重”，可以另写更轻规格并醒目标范围；该方案不能复用全局新意结论。

本轮建议：父任务先审定是否投入严格分块路径；在保持现要求时，先完成真实画像prepare、首页候选只读取样与单候选单块可行性验证，不假称已达到可投递10条。
