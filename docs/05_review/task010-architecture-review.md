> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-010 Architecture Review

日期：2026-10-23。执行者：Codex（架构责任核对）。档位：S3实现、已授权S4有界验证。结论：通过，限TASK-010已实现及已验证范围。必须修复：无剩余架构阻塞。用户已确认第3项最终交付及本地提交，准确清单及提交见交付报告和Git，不启动011。

范围：homefeed/candidates模块、008定向receipt恢复、009执行器的显式筛选契约。仅Node标准库，不改schema，不加依赖。模块新增和公共接口触发Architecture Review。

## 开发前依据
C2C c2c_010a I0通过redbook-final实际读取任务包、任务卡、技术规格和代码，给出`PLAN — PROCEED AFTER P0 DESIGN FIXES`。原文`.codex/task010-c2c-plan-20261023.txt`。Sol独立精简包设计建议与父代理核对一致：来源隔离、真实引用比较、独立执行槽交接、定向receipt归账，不把未分析预检伪造为decision。

四项P0落实见`.codex/task010-plan-20261023.md`：不写收藏观察；只恢复本候选attempt；200由持久唯一候选集合约束；比较证据与三态纯函数分开。原008/009调用与缓存有效性沿原契约，改变偏好/策略不触发全量重新分析。初始策略必须明确active。

## 数据和权限边界
私人库复制到新路径，原009库仅只读核对；不迁移或替换原库。来源、材料、偏好、模型完整日志留忽略的private目录。C2C只读代码、合成测试及脱敏计数；不发送凭据或私人正文。真实来源页面由用户本轮指定lite ego，最多2候选/2新材料分析，不访问新账号或执行飞书发送。

schema沿现有v3实体，无迁移。候选/decision追加，状态历史保留；生成不改recommendation或delivered_content。回退仅本任务代码本地提交及关闭新私有运行，不恢复旧库覆盖外部状态。

## 最终依据与方法
按`ai-delivery-kit/07_quality_gates/architecture-code-quality.md`核对模块、接口、数据生命周期、复杂度和可测试性。本步只读现有实现、暂存差异及已有证据，不改产品代码，不重跑测试或模型。ADR-004记录模块边界及恢复权衡。

C2C I1核实核心链路并提出F1/F2/F3；I2实际返回`DONE — ACCEPT I2 FIXES`，确认三项无剩余阻塞。依据为[开发前审查](../../.codex/task010-c2c-plan-20261023.txt)、[I1](../../.codex/task010-c2c-review-i1-20261023.txt)和[I2](../../.codex/task010-c2c-review-i2-20261023.txt)。不把初版PLAN当最终接受。

## 模块与依赖
homefeed接收调用方绑定的实际页面，只保存来源、content/candidate/batch及检查点，不写收藏观察。candidates负责阶段编排、去重、证据比较和当前候选状态。008负责材料及回执，009负责分析、偏好与严格缓存，存储沿用007。只读历史投递状态，不创建推荐或投递成功。

```text
调用方页面 -> homefeed -> 来源/候选/批次/检查点
                              |
                              v
                         candidates
                              |
              +---------------+---------------+
              v               v               v
         008材料/回执     009分析/缓存      筛选提案+evaluate
              |               |               |
              +---------------+---------------+
                              v
                  v3存储/决定/状态/报告
```

实际import与调用点核对：候选模块调用既有模块，homefeed/collection/analysis不反向依赖candidates，未发现循环依赖。新增依赖为零，schema及包清单无本任务变更。没有新增采集协议、偏好系统、调度器或未来脚手架。

## 公共接口
- 来源使用createHomefeed/beginBatch/refreshHomefeed。20/3/3请求隔离，同owner/commandId/类型重放返回原批，类型冲突拒绝；累计200预算及三次成功推进无新ID停止由持久状态约束。
- 材料调用008 ensureMaterial；新增commitReceipt/resolvePreDispatchFailure只处理确切原attempt。009新增只读inspect，复用accepted/prepareInput；runCodex增加可选schema/prompt/payload，默认分析及偏好调用保持原契约。
- 候选CLI处理已保存候选，返回eligible/excluded/held/pending、版本、缺口及report_ref，不自动连接浏览器。maxCandidates是有序前缀覆盖上限，前缀外仍列pending；提高覆盖后复用完成项，不自动追加来源或扩大预算。
- 探索需明确请求。相关性连续原文校验和增量完整证据比较分开；提案不能绕过版本、材料及引用检查。候选入选不记为已推荐。具体契约见[candidate-contract](../04_specs/candidate-contract.md)。后续展示/投递/调度不在010实现。

## 数据、缓存及恢复
继续使用v3的candidate/decision/baseline/strategy/checkpoint，无迁移。decision为不可变历史，candidate为当前投影。输入及各版本、证据hash关联筛选；版本变化只失效受影响阶段。同语义修复根择严格有效材料，不因repair ID变化重跑分析，不删旧材料。

文件先保存并计算hash，候选状态和checkpoint在同一数据库事务保存。未决采集/筛选保留原candidate阶段；提前hold/reject经独立candidates-outcome阶段保存原因、版本与引用，不覆盖recover读取的原凭据。batch报告独立保存并返回report_ref。动态偏好/来源仍重核，旧eligible不能绕过失效。

008/009/selection串行交接原执行槽。调用前intent、成功receipt后归账；文件与DB之间中断按原attempt核实，不宣称跨文件、数据库及外部调用原子。未知不盲重试。旧无errno回执仅接受绑定原hash、已退出进程及无输出的独立证明，不补造旧错误。

新日批关闭旧可执行队列，保留历史、已投递、unknown及恢复证据。回退本任务代码不覆盖原009库或删除历史。本轮无外部投递动作。单机交接、比较输入容量和可读媒体限制已披露，无需新增抽象或依赖。

## 验证及边界
复用89项组合、后续窄变更28项及最终相关42/42测试，通过证据分层记录，不称最后重跑89项。I2独立读取execution_output ID30核对42项/退出0。来源、版本、证据、repair、停止、配额、回执中断、请求重放与pending均有合成覆盖，见[测试记录](../../.codex/task010-testing-20261023.md)。

既有真实证据为首页2条发现、两份材料及分析、0eligible/2hold/缺口20；重入0新attempt、旧文件与原009库不变、0推荐/投递、槽stopped，报告可读。见[真实重入记录](../../.codex/task010-live-results-persisted-20261023.json)。最后三项补丁只做受影响合成回归，没有重做真实工作。

通过的是本卡架构和接口实现。每日20条供给、陌生领域真实探索、完整视频理解、95%认可率、无人值守12:00及长期产能未验，按既有后续任务处理，不新增为本次架构关闭门槛。

## 收尾状态
用户确认第2项后完成本记录，Architecture Review关闭，第1项C2C已关闭。第3项用户确认后按[最终交付](task010-delivery-report.md)完成准确清单、差异/隐私核对及本地提交。保留原Serena两项暂存，不push、不部署、不启动011。
