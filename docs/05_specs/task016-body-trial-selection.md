> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK016 正文试用筛选

日期：2026-10-28。执行者：Codex。S2。Gate 3：用户已明确批准按真实喜好筛选、排除同帖和明显重复，暂不承诺全库信息新意。

范围：新增 createBodyTrialSelector；只读有效偏好及其外部588 ledger，输入root实际取得的候选正文。复用runCodex中档、JSON schema、verifyCompletion。仅私有文件，不写业务库或发送。全局evaluate不改。

契约：select({candidates:[{source_id,title,body}],collectedIds,deliveredIds})。构造器传store/root/owner/model（默认runCodex）及可选preferencePointer。正文必须非空。排除收藏、已发和本批重复ID；模型仅判断相关性及与ledger主题/核心内容的明显重复。每项返回chosen/hold/rejected、正文逐字quote、hypothesis_indexes、reason。chosen必须支持有效hypothesis。程序检验模型完成、输出SHA、版本、候选覆盖、逐字证据。任何输入/产物/偏好变化拒绝。外部画像ledger hash必须可验证。

产物request/input/output/receipt保存在root的独立UUID目录。返回scope:{kind:accepted_body_trial,noFullNovelty:true,imagesSeen:false}和decisions，禁止宣称全库新意。10条是目标，不为凑数放行hold。

Review策略：本地TDD，模拟真实执行器写输出与完成事件；明确拒绝无完成、坏引用、偏好变化；真实模型试用留root。

2026-10-28 Codex，反馈增量Gate3：用户明确要求点赞/踩矫正后续。selector从当前owner的feedback_current JOIN真实content/recommendation/decision/material读取唯一当前版本，传current_feedback（source_id/value/revision及真实推荐引文、假设索引、标题；旧标准项保留原正文）。不传历史更正前版本，不把无反馈视为dislike。反馈随payload进入输入指纹，模型完成后及投递资格验证重复比较快照，变更即拒绝旧选择。既有真实7条记录/回执不改、不重跑；仅新选择及后续资格校验生效。
