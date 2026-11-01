> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-011 最终交付

2026-10-29，Codex，用户最新规则：[正文优先推送](../04_specs/text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

日期：2026-10-23。执行者：Codex。结论：本卡实现及有界展示验证通过，C2C I2与Architecture Review通过。只提交011确切清单到本地，不push、不部署、不进入012。

## 入口与012调用

代码：[display.mjs](../../src/display.mjs)。调用`createDisplay({store,root,owner,appRef,client})`后，`await buildBatch(batchId,task010Result.eligible)`返回独立items。纯`formatMessage`构建post；`validateRequest`在012发送前计算含目标/uuid的最终请求大小。`invalidateMedia`只在确切成功attempt及失效证据匹配时刷新必要媒体；`recover`核对确切已终止进程，不清未知回执。

每条包含推荐UUID、批次/ordinal、内容/材料版本、decision/类别/实际偏好与策略、展示契约版本、payload/hash、原正文与媒体索引映射及构建引用。编号永久稳定且只追加，恢复/换序不重排。011只创建pending身份，不保存投递尝试、已推荐索引或反馈。详见[接口契约](../04_specs/display-contract.md)。012须再复核当前状态、版本、停止及发送权限，构建成功不等于发送成功。

## 支持范围

普通图文保留标题、作者、原正文、原序图片及完整原URL；CR/LF、空行、特殊字符不作Markdown转换。视频只给实际封面、观看入口和未读标记，不推断视频内容。默认没有AI推荐理由或摘要，decision关联保留。

保守已验结构：无图正文≤6000 UTF16；有图正文≤744 UTF16且≤9图。3篇/每日20篇都按独立消息构建；20篇只做本地组织验证，没有真实群发20篇。超长、十图、未知组合、缺字段/媒体、不可访问来源整体`blocked/display_blocked`，不截断、省图或擅自拆分。

按[飞书官方发送文档](https://open.feishu.cn/document/server-docs/im-v1/message/create)及[图片文档](https://open.feishu.cn/document/server-docs/im-v1/image/create)约束30KB请求体、10MB图片和尺寸；使用保守字节数检查。post未知组件上限不挪用卡片规则，详细来源见[平台证据](task011-platform-evidence.md)。不能把6000字和9图的分立样本合并声称组合通过。

## 验证证据

- 本地相关组合60/60，最终显示26/26、退出0；原文/缺失/媒体顺序/尺寸和字节/超限/视频/编号/失败/unknown/回执损坏/停止/精确刷新均覆盖。保留RED、GREEN，不把文档检查当运行测试。
- 独立Node进程先后上传3/0；UUID、ordinal及payload hash一致。第三intent处以73退出，父进程确认终止后精确恢复：前2成功复用，第3unknown不重传，第4继续成功。fake解码器与实际PNG解码测试分别标记。
- 真实仅3条合成消息、自有横/竖/方图及封面：4上传，重建新增0；3次API code0且有message_id；精确回读3×7项全部匹配。
- 用户明确回复“三条均显示完整，顺序与入口正常”。桌面证据为用户陈述；没有Codex独立截图、移动端或真实视频播放结论。视频本轮入口为合成文档网页；实际原视频入口复用003已确认记录，不冒充新视频验收。

完整命令、计数与限制见[测试记录](../../.codex/task011-testing-20261023.md)、[子进程结果](../../.codex/task011-process-results-20261023.json)和[非私人展示摘要](../../.codex/task011-live-summary-20261023.json)。消息ID、会话、原始回执、正文、图片和凭据留忽略的private。

## 复用、审查与工具

复用006 Gate3、007 v3及材料/分析接口、003 SDK/post/桌面视频入口和004原文9图确认。010实际0eligible/2hold保持，不重采、下载、分析或筛选。新完成011展示适配、稳定编号、媒体回执/构建/停止与精确恢复及验证，不实现后项。

使用using-vibe-delivery-kit、routing-by-risk、ponytail full、计划/TDD/调试/verification-before-completion。S2实现、授权本人展示按S4；读取架构/测试/Review/权限边界及结束规范，既有RDD/PRD/Gate不重做。无CI、新框架或网站。sequential-thinking/shrimp/code-index未提供，记录降级到本地计划、Serena/rg。

Serena实际initial_instructions、激活redbook、符号概览、prepareInput/decoder/formatMessage引用及调用核对均已执行；LSP空引用用rg补查。C2C内置浏览器打开超时且未发送，读取ego技能后切lite ego，复用连接并通过redbook-final核对工作区；一空间/一C2C会话，不扰动采集页，不重复提交。

C2C I0开发前批准带约束；I1发现停止清除、回执未重验、进程身份窗口和空输入误报；逐项复现修复。I2独立读取差异、输出及真实展示摘要后实际`DONE — ACCEPT I2 FIXES`，无剩余阻塞。ADR状态收尾同步。独立Sol AR及Luna进程执行分别留证，不代替C2C。见[架构审查](task011-architecture-review.md)和[I2原文](../../.codex/task011-c2c-review-i2-20261023.txt)。

## 提交、剩余与停止

确切本地提交路径见`.codex/task011-commit-paths-20261023.json`，提交号以Git实际记录为准。保留原两项Serena暂存，不混入提交。原始txt输出保留自然空白；代码/文档/JSON差异检查通过。私人资料排除与最终语法/证据检查见`.codex/task011-final-verification-20261023.json`。

本卡没有未完成的实现或审查项。未验证边界：移动端、真实视频播放、未知大容量组合及长期key有效性；不是隐藏通过。恢复入口为TASK-011、display-contract及`.codex/task011-resume-packet-20261023.md`；已有三条测试消息不重发，有效媒体/构建直接复用。

011对012的实现交付前置已满足。TASK-012仍须用户另行指定，正式投递/反馈闭环未实现。本轮提交与报告后停止，不启用正式推送/部署/调度，北京时间12:00规则保持。
