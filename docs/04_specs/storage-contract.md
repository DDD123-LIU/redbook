# TASK-007 存储契约

日期：2026-10-21。执行者：Codex。依据：`technical-spec.md` §3、§4、§4.1、§12。

2026-10-23，Codex：TASK-009当前存储版本为v3，只将analysis完整输入唯一索引换成非唯一查找索引，支持保留损坏旧成功并追加新attempt。材料身份/repair、外键与不可变触发器不变；见[ADR-003](architecture-decisions/ADR-003-analysis-attempt-recovery.md)。007/008历史验收不回写。

2026-10-22，Codex：TASK-008按实际发现的补采引用冲突显式修订至Schema v2，设计经C2C ITERATION1和Sol核对，见[ADR-002](architecture-decisions/ADR-002-material-repair-records.md)。本轮实现及迁移最终审查见TASK-008记录。007原39项和历史C2C结论不回写。

## 打开与事务

`openStore(path, { readonly? })` 打开 Node 24 `node:sqlite` 数据库。它启用外键、5 秒 busy timeout，并检查固定的 SQLite `application_id`、`schema_version=3`、完整性和外键。空库在单个 `BEGIN IMMEDIATE` 中初始化。初始化会写入一个 `unconfigured` 的策略版本，不代表已经选择或启用策略。v1/v2库明确要求显式升级，不在打开时自动改写。

非空但未版本化的数据库、未来版本的数据库和检查失败的数据库会被拒绝。打开失败会关闭连接。已有私人库不会自动迁移。`readonly: true` 只读打开已初始化的库。

`store.db` 提供标准 `DatabaseSync`，用于受约束的 SQL 读写。`store.transaction(fn)` 使用同步事务；嵌套调用使用 savepoint。回调必须同步，不能等待网络或其他异步任务。异常会回滚本层写入。数据库外的平台发送不能放在事务里。

## 状态比较并交换

`casSlot` 使用 owner、run_id、generation、stop_requested、state 和 revision 一起核对单执行槽。它不按超时抢槽。槽只有 `main` 一行。条件不匹配时返回 `{ status: 'rejected', entity_id: 'main', changes: 0, evidence_refs: [] }`。

`casState` 支持 `batch`、`recommendation`、`delivery_attempt` 和 `outbox`。输入包含实体名、实体 ID、期望状态、期望 revision 和新状态。SQL 在同一条条件 `UPDATE` 中核对状态与 revision，并递增 revision。成功返回 `succeeded`；0 行返回 `rejected`。状态历史由数据库触发器追加。`casFeedback` 以本人、平台、来源内容 ID 和期望 revision 更新 feedback_current；新事件、current、history 与 outbox 应由调用方放进同一个 `store.transaction`。

尝试状态只允许 `pending / intent / succeeded / failed / unknown / cancelled_before_dispatch`。进入 `succeeded` 必须同时保存非空 `message_id` 和至少一条非空核实证据引用。未决 `unknown` 存在时，同一 owner、平台和来源内容不允许新建 `intent`。attempt 和其他状态迁移均追加不可变历史。

## 内容、版本与关联

`saveContent(store, { platform, content_id, source_url_ref?, source_state?, last_observed_at? })` 按 `(platform, content_id)` 幂等。来源 ID 是稳定身份。缺少 ID 时函数拒绝写入。

这里的输入 `content_id` 是Spec的来源ID。物理表 `content.content_id` 为内部UUID，`source_content_id` 保存来源ID，唯一键为 `(platform,source_content_id)`。返回 `entity_id` 是内部UUID；所有子表的 `content_id` 外键使用该UUID。逻辑身份仍是Spec约定的平台与来源ID，没有以标题或URL代替身份。

`saveMaterialVersion(store, input)` 接收内部 `content_id`、`body_ref/body_hash`、`ordered_images[{index,path,hash}]`、`cover_ref/cover_hash?`、`media_kind`、`published_at?`、`fetched_at?`、`completeness`、`fetch_status?`、`evidence_refs[]`。默认fetch_status为succeeded；成功记录必须提供 `body`（包括明确的空字符串）或有效 `body_hash`，缺少二者时拒绝，避免把缺失正文误记成空正文。显式空正文仍须由来源证据支持，并接受完整性校验；视频未读按video_unread保存。正文只为可选计算摘要输入，不写入表。成功返回 `{status:'succeeded',entity_id,evidence_refs}`；匹配成功材料返回duplicate。非法输入或数据库约束冲突抛错，调用方不得把异常当成功。

`casSlot(input)` 的必填字段为 `owner,runId,generation,stopRequested,expectedOwner,expectedRunId,expectedGeneration,expectedStopRequested,expectedState,expectedRevision,nextState`；初次获取的期望owner/runId为null、generation/revision为0、stop为false、state为idle。后续必须读取真实旧值，不沿用初次条件。可选 `batchId,updatedAt`。`casState` 必填 `entity,entity_id,expectedState,expectedRevision,nextState`，可选fields为模块白名单中的时间/停止/尝试证据字段。`casFeedback` 必填 `owner,platform,sourceContentId,expectedRevision,value,eventId,savedAt`；已有event必须与当前对象一致。

`materialHash({ bodyHash|body_hash|body, orderedImages|ordered_images, mediaKind|media_kind, coverHash|cover_hash })` 只散列正文哈希、按连续索引排序的图片哈希、媒体类型和封面哈希。它忽略抓取时间、URL、token 和图片路径。图片索引从 0 或 1 开始，连续递增。`saveMaterialVersion` 重新计算并核对传入哈希；重复成功版本返回已有版本。失败版本只追加记录，不覆盖成功版本。

`store.db` 是受数据库约束的原生 SQL 入口。跨表写入必须放在 `store.transaction(fn)` 中；状态更新使用相应 CAS 方法。调用方不得关闭外键或绕过状态归账。TASK-007只提供存储原语，不代替TASK-012/013/014的业务编排。

素材版本、分析、偏好、策略、基线、决策、报告修订和投递归属均不可改写。v3分析对相同 material_version、input_hash 和 prompt_version 的complete使用非唯一查找索引；analysis_id仍唯一。有效缓存优先核验并复用，旧结果损坏可追加独立成功attempt并保留失效原因；失败/partial历史保留。执行者必须遵守单槽CAS与入库前复核，不以索引放宽为重复模型调用授权。

### v2：同内容的物理修复

`saveMaterialVersion`新增可选`repair_of_material_version_id`。它必须指向同内容、同material_hash、同媒体类型及完整性的普通成功根，不允许修复链。普通成功仍按内容/H去重。明确修复才允许同H追加不可变物理记录；storage从正文、连续有序图及封面的实际路径+hash计算`artifact_hash`，相同修复产物重放返回duplicate。传入伪造artifact_hash、缺少完整引用或不匹配的父版本时拒绝。storage不替采集模块读文件或解码；008须在保存前完成实际校验。

`material_version_id`是物理记录身份，`material_hash`仍是内容身份。修复不表示源变化。009后续应沿同根/同H和真实分析输入复用有效分析，不因修复ID不同就自动重复分析。本轮只定义009输入责任，不提前实现009。

候选与分析必须指向同一内容。推荐必须与其决策的内容、类别、偏好和策略版本相同。反馈事件、当前值和推荐必须匹配。成功内容索引会复核 owner、平台和来源 ID 与推荐批次一致。

偏好版本中的 `supporting_content_ids_json`、基线版本中的 `material_version_ids_json` 是关系集合的唯一输入。创建版本时，触发器依据这些 JSON 数组生成带外键的关联行。关联行不可增删改；无效 ID 会使创建事务失败。

`collection_batch` 保存观察范围及 coverage。`collection_observation` 外键指向真实批次和内容。局部缺席可以存为 `unknown`，不会自动转成取消收藏或来源删除。

## 文件备份与恢复

`store.backup(destination)` 和 `restoreStore(source, destination, expectedSchemaVersion?)` 只写入新路径。两者先备份到同目录临时文件，再检查 schema 版本、`integrity_check` 和 `foreign_key_check`，最后以不覆盖已有文件的方式发布。源文件版本或检查无效时拒绝恢复。目标已存在时不改写。

实体只保存来源材料引用和哈希，不保存正文、图片字节、Cookie 或密钥。完整性证据使用 SQLite 检查结果；数据库备份不撤销任何外部发送。

当前支持空库v0→v3初始化；显式`await upgradeStoreV1(source,destination,{backupPath})`保留v1→v2原义；新增`await upgradeStoreV2ToV3(source,destination,{backupPath})`只改分析索引。版本号保存于`PRAGMA user_version`，产品标识为`PRAGMA application_id=1380201035`。source必须为对应版本的停止执行产品库，执行槽为idle/stopped且无owner/run/stop请求；source、destination和backupPath必须不同，后两者必须为新路径。函数只读核对源库，先创建一致旧版备份，再从备份升级隔离目标，外键/完整性/版本通过后不覆盖发布。失败保留源及已完成备份，不发布目标。下载器库和其他非空未版本化库一律拒绝。

`restoreStore(v1Backup,newPath,1)`与`restoreStore(v2Backup,newPath,2)`可在新路径恢复旧版以回退取证，当前openStore打开仍须显式升级；默认恢复要求v3。恢复不替换活动库，不撤回外部动作。备份及升级发布保留本机硬链接文件系统限制，未证明全部文件系统兼容。

## TASK-007历史验收边界（原结论保留）

2026-10-21，Codex：本地39项隔离测试通过；Architecture Review及初始化锁次序小delta复核通过。C2C方案补审和最终独立Review均实际完成，c2c_007a ITERATION2为DONE—ACCEPT；开发前C2C缺失仍留作流程偏差，不追认。详见 [架构审查](../05_review/task007-architecture-review.md)与[C2C记录](../../.codex/task007-c2c-review-20261021.md)。007交付依赖已满足，008仍须用户指定，不自动开工。每日北京时间12:00规则保持，本模块不部署或启用调度。
