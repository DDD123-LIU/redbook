> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK016 正文试用投递资格

日期：2026-10-28。执行者：Codex。Gate 3：父任务确认实现；用户已授权本轮正文试用和真实触发。S3，复用TASK016范围，Architecture Review：不迁移schema，不改变旧完整资格。

登记真实selector的CLI receipt为analysis.status=partial、prompt_version=body-trial-selection-v1。这是实际正文筛选分析，不是旧逐帖complete。decision.result=hold、gain_state=undecidable，reasons_json保存明确body_trial_chosen资格契约；baseline descriptor声明input_complete:false/noFullNovelty:true。candidate保持hold。独立verifyBodyTrialDecision严格核来源、当前偏好策略、候选正文哈希与逐字引文。只有该契约可进入新display/delivery分支，旧eligible路径仍要求完整analysis和baseline。

接口prepareBodyTrialDecision({store,owner,batchId,candidateId,materialVersionId,selectionRefs,now})只验证并返回publish。publish重新验证后事务登记analysis partial、baseline、decision；不发送。已有candidate必须绑定真实homefeed evidence和本批，材料必须绑定同content。真实recommendation由原display创建；原delivery发送与feedback身份关联复用。

display新分支只展示真实正文、标题、作者、入口以及“正文试用：图片未读；未承诺全库信息新意”。不将图文材料改写为完整text记录。容量及真实身份校验沿用。delivery每次prepare/dispatch重新verifyBodyTrialDecision，再走原幂等、去重及回执。

测试：登记旧标准不受影响、假receipt拒绝、篡改正文/来源/偏好拒绝、display保留正文scope、delivery隔离transport调用且不访问网络。正式主库由父任务Review后操作。本实现不运行真实发送。
