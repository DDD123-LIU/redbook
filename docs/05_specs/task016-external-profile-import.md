> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK016 外部正文画像导入窄规格

日期：2026-10-28。执行者：Codex。范围：父任务已接受的正文阶段画像接入。S2，本地准备与隔离验证；生产发布留父任务 Review。

Gate 3：范围明确。新增 external_accepted_body_profile 根类型，不替代 CLI 根及 explicit_instruction 子版。不修改 analysis 表，不声称模型完成或图片已读。

接口：prepareExternalBodyPreference({store,root,owner,profileRef,ledgerRef,acceptanceRef,materials,now})。materials 为 note_id 到 material_version_id 的映射。接受记录包含 kind:human_acceptance、accepted:true、profile_hash、ledger_hash、source:{text,recorded_at,chat_ref}、model_source:{interface,model,observed}。observed 可明确 unknown。模型名称是来源陈述，不是运行证明。

准备时逐条核验材料正文哈希、唯一 note_id、正文逐字证据。画像每条证据也必须在对应正文中出现。长期假设必须 false；图片必须未读。缺正文记录必须空证据，不可支持画像。输出映射为原 hypotheses 契约，支持 ID 使用 external-body:<note_id>，不冒充 analysis_id。limitations 保留原限制并添加正文范围说明。

准备只写不可覆盖的私有输出和 manifest，不写数据库。返回 pointer、preference_version 和 publish。publish 单事务检查准备时 current 未变、所有文件及正文证据仍有效，再写偏好行和 current checkpoint。verify 读回重复核验来源及材料。损坏任意来源或正文均拒绝。不得覆盖既有明确指令，沿用 current 的明确指令。

验证：先失败测试，再实现；测试隔离数据库，验证 prepare 零发布、publish/verify、来源和正文篡改拒绝、旧 CLI/人工子版回归。

Architecture Review（实现前）：复用 preference 原模块、数据库与 Node 标准库；无新表或依赖。画像可供 relevance 使用，但候选 baseline 仍要求完整旧材料与媒体。有限正文 trial 必须另建显式范围入口，以所有已接受正文为比较全集，按候选证据×正文基线分块核验后汇总；每块绑定同一 manifest、材料 ID 全集和哈希，任何块缺失均 hold。不得将正文 trial 的 input_complete 用于全局 evaluate。320KB 输入上限及完整交叉比较要求决定不能只塞画像或摘录替代完整基线。本轮不实现此路径。
