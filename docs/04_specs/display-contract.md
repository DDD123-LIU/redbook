# TASK-011 飞书 B 式展示接口

2026-10-29，Codex，用户最新规则：[正文优先推送](text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

日期：2026-10-23。执行者：Codex。版本：feishu-b-v1。当前为实现及验收中的实际接口，最终状态看TASK-011。

## 入口与调用边界

`createDisplay({store,root,owner,appRef,client?,uploadImage?,decodeImage?,now?})`返回`buildBatch(batchId,eligibleRefs)`、`recover({confirmedStoppedRunId,evidenceRef})`和下述`invalidateMedia`。root是Git忽略的私有产物目录；appRef是稳定应用引用，必须与传入SDK客户端对应。默认图片解码复用analysis.decodeImage；注入解码器须返回实际width/height/format。SDK沿用官方`im.image.create`，也可传入只上传图片的适配函数。模块没有消息发送依赖。

`buildBatch`接收010实际eligible引用数组，每项必须有decision_id；可带candidate_id/content_id作交叉核验。沿decision→analysis→material和candidate→content读取不可变关联及批次。非eligible、错误批次/引用、损坏材料均阻断；不修改010决定。当前只创建pending recommendation身份，不创建delivery_attempt、不改已推荐索引或反馈。

批次必须属于owner且未closed_day。函数在007单执行槽空闲时取得CAS，先保存进程身份再取得槽，结束释放到stopped并保留实际stop_requested意图。槽未知或被占用时停止，不超时抢占。TASK012/013应按阶段交接槽，不能持自己的槽再调用本入口。外部明确停止由012/013在用户明确恢复时重设，不由011的finally静默清除。recover只释放指定已证明终止的本模块进程槽；它不把未知媒体当失败，也不重发消息。

`formatMessage(recommendation,completeMaterial)`是纯构建函数。输入是上述适配器已核验的绑定身份、fields.title/author_name、原body、有序images、视频cover、source_url/source_status和材料版本。它不读DB、不上传、不发送。输出post的zh_cn标题及逐段text/img/a；正文使用单一text保留CR/LF、空行及特殊字符，原图每张独占段落，不作Markdown转换。

## 编号与标识

recommendation_id仍是存储契约中的永久UUID。批次标识沿delivery_batch_id。ordinal只用于批内展示，不是第二套业务身份。首次出现的有效条目依输入顺序追加序号；后续输入顺序变化、新条目、失败和重启都不改旧映射。消息标题同时显示batch / ordinal / UUID及原标题。

编号保留文件先写入私有批次目录，并绑定owner/batch/ordinal/UUID/decision/content/material/version。随后在同一数据库事务中检查关联、创建pending recommendation和manifest checkpoint。事务失败遗留的确切reservation须核对hash及关联后复用，不生成第二UUID。manifest/receipt/checkpoint损坏不能回退到旧文件冒充成功。设计权衡见[ADR-005](architecture-decisions/ADR-005-display-identity-and-receipts.md)。

## 返回值与012输入

批次返回`status,entity_id,delivery_batch_id,display_contract_version,items,evidence_refs`。条目包含`status,display_state,recommendation_id,delivery_batch_id,ordinal,category,decision_id,content_id,material_version_id,display_contract_version,payload,payload_hash,media,mapping,metrics,reasons,evidence_refs,build_ref,build_hash`。成功条目含实际偏好/策略版本及材料/正文hash。

构建成功为`status=succeeded,display_state=complete`。失败/不完整统一`status=blocked,display_state=display_blocked`，payload/hash为null，错误含code/stage/retryable/observed_at/detail_ref；原因及media实际状态分别保留。批次partial不阻止其他完整条目。空eligible输入返回blocked、no_eligible_input、空items及批次目标缺口，不取槽或误报成功。构建成功、图片上传成功、API接收和客户端完整显示是四件独立事实。

012读取并核对build_ref/build_hash、payload_hash及绑定版本，使用`payload.msg_type/content`，不得临时重组正文。`validateRequest(payload,{receive_id,uuid})`核对含目标及UUID的最终请求UTF8大小；012在发送前必须调用并复核当前收藏、投递、unknown、停止及版本状态。payload_hash不作身份去重，编号不代替012核实送达。

## 媒体与恢复

每张媒体先核对原索引、hash、实际解码、非空/10MB及尺寸，再上传。全篇材料及容量预检通过后才开始上传。封面与普通图片分开；视频封面即使已在材料数组也只显示一次，保留未读标记和观看入口。不压缩、缩图或替换为文件。

媒体checkpoint绑定应用hash、材料版本、role/index、媒体hash、attempt和回执位置。上传intent先落盘，再调用SDK；image_key回执先保存，再归账。重启复核原始receipt文件hash及全部绑定后复用成功，只续明确失败或未开始项。intent已有确切成功或非零平台码失败回执但未归账时，可同等绑定核验后补账。异常、缺key、错绑/损坏回执及无回执保持unknown，不自动重传。成功checkpoint的原回执丢失/损坏时也阻断，不凭checkpoint冒称有效或盲重传。未知需要先查原attempt和平台证据；不能仅凭本地文件存在认成功。应用改变不复用旧key。

材料损坏交008有界修复；不得为011重新采集整批或分析。媒体key失效须先取得确切平台证据。`invalidateMedia({batchId,materialVersionId,index,role?,mediaHash,expectedAttemptId,evidenceRef})`在单槽下仅失效匹配的成功回执，保留旧记录；随后buildBatch只刷新该项，其余有效媒体复用。调用方负责evidenceRef确实对应指定key失效，不允许用此接口清除unknown。没有自动有效性探测，不把历史上传成功当永远有效。

## 容量和来源

官方值、来源和未验项见[平台依据](../05_review/task011-platform-evidence.md)。保守UTF8请求体30000字节、单图10000000字节；GIF≤2000x2000，其他≤12000x12000。封面计图。未知post组件上限不套用卡片规则。

图文组合沿已验结构：无图正文≤6000 UTF16；有图正文≤6000 UTF16且图数≤9（2026-10-29同条长文九图实测）；段落形状不超过既有13行结构。这是支持范围，不是平台硬上限。图文组合超界时，buildBatch默认转为完整正文并标注图片未附；正文单独仍超界才blocked，附实际度量。不截断或改摘要，不将未知图文组合冒充已验证。更多图文范围仍须真实证据。

完整URL从候选来源证据按可靠content ID提取；`content.source_url_ref`不能直接当URL。保留实际query。来源不可访问或缺字段阻断，不编造作者、正文、封面或链接。unknown来源状态只作未核验，不声称链接当前可用；实时可用性与客户端打开另行记录。
