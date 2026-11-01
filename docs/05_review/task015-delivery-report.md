> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK015 本地技术集成交付

2026-10-29，Codex，用户最新规则：[正文优先推送](../04_specs/text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

日期：2026-10-26。执行者：Codex。档位S3，真实平台按既有S4边界。C2C I3最终结论：TASK015 LOCAL Gate PASS / SCOPED LOCAL TECHNICAL ACCEPTANCE。本卡有界本地技术验收通过，不进入016。

新增37个独立本地检查，另有9个受影响旧回归。采用真实产品factory、隔离SQLite和合成外部adapter。覆盖首页至查询、跨连接/跨Node防重、部分恢复、额度/材料、停止/午夜、媒体/增量/类别/策略、反馈/质量、真实子进程崩溃及明确继续。父测试容器及历次重复不重复计数。逐组日志/命令/SHA见`.codex/task015-verification-index-20261026.json`，任务卡映射见`task015-acceptance-map-20261026.md`。

两个产品缺陷已修：TASK008可靠删除分支未定义batchId导致事务回滚，复用既有非成功事务统一归账；TASK013上一条成功phase遮住下一条已准备意图，每条prepare前重记running，不放宽恢复门禁。均有真实RED/GREEN、所属契约更新和Sol独立AR。合成19→20退出73后，恢复取消未派发旧attempt，经明确continue完成原批，20条唯一发送、旧19及有效分析/展示指纹不变。

C2C I0/I1/I2实际审查及I3最终独立审查已取得。I3核16/16冻结代码SHA，两个所属修复均DELTA PASS，37新增/9旧回归按逐场景口径接受，无剩余P1或阻塞P2。原文见`.codex/task015-c2c-i3-review-20261026.txt`。审查方读取归档manifest，未独立挂载private现场；执行方已复制和核SHA。原有007—014有效证据按原范围复用；不重采、分析或重发旧成功，也不拼作本轮真实平台整链。

所有新平台行为均为合成；completed20不是016正式20。质量monitor目标null、资格pending。正式runtime/fresh XHS Page/真实平台连续链、全量偏好/试用充分性/真实质量与生产运行仍未验。未穷举running记录后intent创建前及任意指令点崩溃，缺证据保持recovery_required。生产禁用，无CI/新依赖/真实新采集模型上传外发/push/部署。

原始失败、测试错误和绿色分开保存；旧错误午夜结果作废。合成DB/材料/receipt/checkpoint保留原路径并复制项目私有归档，SHA及恢复语义见archive manifest。最早run5丢失现场如实标缺口。原其他任务stage和dirty不混入提交。准确状态见TASK-015-HANDOFF；额度<4%/2%立即暂停，重置后须用户继续。
