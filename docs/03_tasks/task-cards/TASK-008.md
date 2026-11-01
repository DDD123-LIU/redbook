> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../../04_specs/recommendation-count-policy.md)与[最新验收](../../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-008 收藏局部发现与材料采集

本项已获用户明确指定执行。完成后停止，不进入TASK-009；不使用付费API、不增购额度、不接CI、不建设独立网站或App。沿用Node标准库和现有项目生态。

日期：2026-10-21启动，2026-10-22额度中断后续作完成。执行者：Codex。责任：后端采集编排。状态：有界实现与验收完成；Architecture Review及实际C2C c2c_008a ITERATION2 DONE—ACCEPT通过。仅本任务本地提交，不进入009。对应规格：[technical-spec.md §4—5、§12](../../04_specs/technical-spec.md)及[采集运行契约](../../04_specs/collection-contract.md)。

## 本轮实施与证据

- Gate3及007的39项、Architecture Review和实际C2C DONE均已核对，不仅依据聊天判断。
- `src/edge-favorites.mjs`提供受支持Edge Tab注入的`discoverFavorites/runFavorites`；`src/collection.mjs`提供逐批事务、既有CLI、结果核验、缓存、receipt恢复和本地resume/recover。无自研驱动/采集协议/下载器。
- 真实1个收藏批次内先后2次有界现场读取、2唯一ID、CLI2次、正文和2图落007。第二项afterReceipt受控中断后恢复，新增CLI0；入口重跑及逐ID核验复用，原材料hash不变。仅局部，见`.codex/task008-live-results-v1-20261021.json`。
- 源DB采集时间、CLI完成及核验时间分开。首draft成功行fetched_at曾用核验时刻，保留历史偏差并列源DB时间；现代码已修复，不回写旧行。
- 同H补采引用冲突已交C2C/Sol明确设计Schema v2。新路径升级保留源库/备份及原材料，见ADR-002及`.codex/task008-migration-results-20261022.json`。不把repair当源改变。
- 最终AR发现已修复；存储39项、repair5组、24项采集测试与8项Edge检查通过。Architecture Review及最终C2C Review通过，v2真实resume入口退出0、pending0、CLI新增0。汇总`.codex/task008-testing-20261022.md`和`.codex/task008-review-20261022.md`。

完成边界：本地检查点及已保存材料恢复已验证；浏览器仅同一已加载Tab重绑续读，运行中断线自动重连与深分页锚点恢复未验证。登录/删除/视频/坏图修复的异常分支为合成验证。全量留016。首draft时间偏差与原始不可变记录保留。本任务关闭不把这些限制改为通过。

运行说明：[collection-contract](../../04_specs/collection-contract.md)。续作：`.codex/task008-continuation-20261022.md`。原两项Serena暂存改动不混提交。

## 目标与范围

复用经授权的Edge页面读取和现有XHS CLI，采集收藏页当前可观察的链接与详情材料，并按检查点分批保存。实现discoverFavorites(collection_batch_id, checkpoint?)和ensureMaterial(content_id, complete_source_url, existing_version?)契约。报告局部覆盖，不把局部未出现推断为取消收藏。

不开发浏览器驱动、逆向采集协议或下载器，不搜索新推荐候选，不分析偏好，不改收藏或发送消息。收藏全量覆盖由016处理，本项不为此扫描全量。

## 输入、接口与输出

输入：007存储事务；当前授权的收藏页和账号范围；已有检查点、已知ID及完整详情URL。发现输出含observations[], observed_ids[], coverage, next_checkpoint, state；观察字段含批次、content_id、observed_at、membership、evidence_ref。材料输出为新增material_version，含正文引用、有序图片[{index,path,hash}]、媒体类型、抓取时间、完整性、证据引用及状态。完整URL私有保存，不把query参数写入公开日志。

明确区分present / confirmed_removed / unknown和incomplete / temporarily_unavailable / source_deleted / access_blocked / unknown。只有可靠来源证据才标删除或确认移除；视频未读保留video_unread。

## 开工前置与验收

前置：007通过、TASK-006 Gate3通过、用户按编号指定008；真实页面读取按已有账号/会话授权执行。不得因卡片存在自动开工或要求用户重确认已确认范围。

本地验证用Node标准库和隔离数据：同一链接重复观察不重复新增content；检查点写入后中断可从下一未完成ID继续；页面局部失败时coverage为partial/unknown而非全量完成；同ID材料变化形成新版本且旧成功版本保留；图片索引乱序、缺图、损坏文件、CLI exit 0但业务失败均不得标材料完整；明确删除需有来源证据，无证据的404/超时保留unknown；视频只标封面/正文可得及video_unread，不伪称媒体分析。每例保存输入、预期、实际状态与本地退出码。

复用历史可行性证据，不重采已有有效材料、不重跑分析。真实业务边界、合成状态分支分别记录。Review检查完整URL传递、检查点范围、状态分类及私有数据不外泄。计划证据：.codex/task008-testing-<日期>.md、.codex/task008-results-<日期>.json、.codex/task008-review-<日期>.md。使用既有Node标准库方式，不新增依赖/脚手架/CI，不虚构命令。

## 停止、回退与后续

用户停止或连接失效时不启动后续页面/下载步骤；保存已完成项、待处理ID、失败和unknown。恢复先校验检查点及材料hash，只补未完成项。失败版本另存，不覆盖有效材料。不得清理其他任务文件或私有源。完成Review后只报告008结果，不自动启动009。

当前边界：收藏覆盖和通用取消识别沿既定受限范围；失败不冒充取消或删除。B1/B3/B4沿已确认方案，006规格Gate3保持通过。用户已指定本项，不扩大到009或部署。
实施顺序的直接前置：TASK-007。同时必须满足TASK-006与Gate3；技术输入及额外依赖以本卡正文为准。
