# ADR-005 展示身份、编号与媒体回执

2026-10-29，Codex，用户最新规则：[正文优先推送](../text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

日期：2026-10-23。执行者：Codex。状态：已接受；独立Sol及Codex Architecture Review通过，C2C I2 DONE—ACCEPT I2 FIXES。发现均已关闭，见task011-architecture-review和TASK-011。

010只输出eligible decision，现有recommendation用UUID且没有ordinal列。011需要稳定批内编号、完整展示及逐图恢复，但不能提前实现012投递状态机。

决定：沿007 Schema v3和单执行槽CAS。011只创建pending推荐身份。私有不可变reservation先保留UUID与ordinal，随后事务校验并创建身份及manifest checkpoint。恢复只核对确切记录与DB关联；追加序号不重排。UUID仍是永久权威身份，ordinal只辅助显示。采用现有文件产物+DB引用模式，不加schema或依赖。

媒体按app/material/role/index/hash分开保存intent和receipt/checkpoint。已知失败可续；未知不重传；成功回执先落盘、再入checkpoint，支持确切补账。构建文件保存实际payload/hash及映射；不建立发送或反馈记录。图片解码复用analysis.decodeImage，新增返回实际尺寸，旧分析调用者保持忽略返回值的用法。

取舍：不做通用媒体服务、任务队列或新消息协议。文件与DB不是原子资源，单槽、保留记录和确切恢复承担间隙。任一成功产物/manifest损坏都不能因存在而复用。未知媒体不能自动清除，可能需要人工核实平台；这比盲重传更符合当前恢复契约。

回退：回退011代码及关闭新的私有验证入口；不覆盖旧任务库、不撤回消息、不删除旧回执或编号。无schema迁移。不会改变12:00（Asia/Shanghai）、推荐筛选、调度或正式发送边界。
