> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK-008 收藏采集运行契约

日期：2026-10-21。执行者：Codex。依据：technical-spec v1.0 §4、§5、§12；storage-contract。实现核验和最终状态见TASK-008及本轮Review。

2026-10-23，Codex：TASK-009将当前storage版本修订至v3（仅分析索引，见ADR-003）。当前代码不隐式打开旧v2库；旧v2验证命令是008历史证据，使用新版代码时须显式升级到新路径v3并传入该db，不能改写原库。本轮已有新库`.codex/private/task009-live-20261023/state-v3.sqlite`；采集root仍为008原目录，材料/批ID不变。009没有重采或重新发现。

2026-10-22续作，Codex：同内容损坏补采需要Schema v2显式物理修复记录，见ADR-002及storage-contract。C2C ITERATION1已审查设计，未以初始“不改schema”掩盖接口缺口。

## 运行入口和边界

产品入口为 `src/edge-favorites.mjs` 的 `runFavorites({collector,tab,collectionBatchId,...options})`。`tab`必须由当前Codex代理通过已有Edge扩展工具绑定。普通Node进程不拥有该工具通道。此入口不创建浏览器驱动、不连接自造端口、不读取Cookie、不点击下载器GUI，也不包含模型/偏好/候选/飞书/调度。

运行前提：电脑与Codex运行，现有Edge扩展已连接，用户登录且打开本人收藏页；现有XHS CLI和私有settings可用。北京时间12:00业务规则保持，TASK-008不启用计划。收藏全量覆盖留TASK-016。

```text
受支持的Edge收藏Tab
        |
        v
读取当前一批可靠ID和完整href
        |
        v
私有原始观察 -> 007观察+待处理检查点同事务
        |                      |
        | 保存后才可推进页面    v
        |                旧有效版本hash核验 -> 复用
        |                      |
        |                   缺失/需更新
        |                      v
        |                intent -> 现有XHS CLI
        |                      |
        |                receipt + 正文/图片核验
        |                      |
        +------------------>007材料版本/状态
                               |
                            检查点归账
```

## 发现和来源

`discoverFavorites(collector,tab,collectionBatchId,options)`每次返回前保存实际读取的一批。配置包括token、checkpoint、maxItems、maxBatches、advance。默认2个新观察ID、最多1次DOM读取；这些是调用级有界样本参数，不是产品永久数量或总时限。

只从当前收藏页`section.note-item`取得可靠ID和同卡完整详情href。实际token仅访问参数，不作为身份或内容变化。每次记录现场来源、读取方法、UTC观察时刻、本次及累计唯一数量、检查点、锚点、停止原因、partial覆盖与总数未知。历史清单不能冒称现场来源。DOM窗口不是累计清单。未观察到不变更既有收藏关系，不推断取消、删除或不喜欢。

无新增时以`no_new_in_dom_window`停留在局部覆盖；不推断已经到底。登录、验证、错误页面或浏览器读取/滚动失败保存已有进度并停止本轮页面推进，不盲目重试。恢复到其他账号/来源时拒绝续入原批。

## 材料、复用和恢复

材料始终按来源ID关联007内部UUID。正文和媒体引用指向私有本地文件。成功版本不可覆盖；URL参数或抓取时间变化不构成内容变化。有效版本经文件hash与必要解码检查后复用，报告`source_rechecked=false`；这不证明源内容仍未变。明确刷新或可靠变化证据才重新取源并按实际字节形成版本。

CLI独立attempt保留调用前intent、实际完成时刻、业务计数、对应作品DB行、正文和媒体清单。退出0不足以成功。图像数量、连续序号、内容hash及可解码检查共同确定完整性。视频仅保留已取得正文/封面/文件状态及`video_unread`，不声称理解视频。

本地恢复先校验receipt绑定和实际文件，再归账；文件存在不能单独当作成功。进程存活或状态未知不接管执行槽。停止和异步返回后的代次复核阻止旧worker推进新运行。错误、失败、待核实和未开始分开保留。可靠删除证据才记source_deleted；404/超时不自动判删除。收藏关系独立于材料获取状态。

2026-10-26，Codex，TASK015集成缺陷回归TASK008：可靠删除的业务结果和receipt为`source_deleted`，content.source_state同值；本次材料获取物理记录为`fetch_status=failed/completeness=unknown`，归入failed checkpoint引用，保留可靠删除证据。它不新增Schema枚举，不把缺失材料伪装成空正文成功，也不删除已有成功版本。

可靠删除是受信采集adapter的明确结果：同时提供`reliableSourceDeleted=true`和非空`sourceDeletedEvidenceRef`，引用应由adapter保存其已核实的来源证据。本模块不从普通404、超时或stderr自行推断删除；该标志不是未经验证输入的删除授权。当前合成测试只验证adapter契约与本地归账，不证明真实平台的删除识别能力。

v2补采只调用CLI的缺失图片序号（`--index "1 3"`格式），复用其余有效图；正文或源媒体清单改变时不拼接不同版本。成功修复指向原普通根，新的物理记录保存有效路径，旧文件/版本不覆盖。采集完成时刻、源DB原始采集时间、verified_at/rechecked_at分别记录；复核不冒充重新采集。

浏览器恢复与本地材料恢复分别验收。重绑同源标签可从保存的已观察ID排除重复，再继续读取当前已加载窗口。深分页、浏览器重启后自动定位及无人工帮助的长期重连均不由本地材料恢复测试证明。当前未测的部分保持限制，不扩大采集补证。

## 私有目录与交付

数据库、settings副本、完整链接、下载器日志、正文和媒体均在`.codex/private/`或已有Git外私有区。公开仓库只保存实现、合成测试、引用和脱敏计数。恢复和停机不删除原材料。最终命令、实际覆盖、故障点证据与未验边界在本轮testing/Review中给出，不能将此契约文档当作运行通过。

## 使用与准确恢复入口

收藏发现必须由拥有Edge工具通道的Codex代理执行。先从工具库存找当前`tab=fav`页面，绑定该标签；不要关闭用户其他小红书登录页。代理加载本地`openStore/createCollector/runFavorites`并传入该Tab。运行配置由调用方提供`root,db,owner,settingsPath,executable,collectionBatchId`；不含明文凭据，settings只传已有私有文件路径。

```javascript
// 在已初始化的受支持浏览器工具运行时执行。rootPath为当前项目绝对路径。
const {openStore} = await import(`file:///${rootPath}/src/storage.mjs`);
const {createCollector} = await import(`file:///${rootPath}/src/collection.mjs`);
const {runFavorites} = await import(`file:///${rootPath}/src/edge-favorites.mjs`);
const store = openStore(config.db);
try {
  const collector = createCollector({...config,store});
  const result = await runFavorites({collector,tab,collectionBatchId:config.collectionBatchId,
    maxItems:2,maxBatches:1});
  // 只展示脱敏计数；完整链接和正文不粘贴回聊天或审查包。
} finally { store.close(); }
```

这里的2项是本次有界验证样本参数。新范围由明确指令给出，不能默认扩大到全部收藏。再次执行同批会核验已有成果并跳过有效材料；继续发现时传入保存的同源checkpoint。只在页面/扩展/登录等前提满足时可自动读取链接，无需手工复制或打开GUI。

本轮真实样本已完成，常规续作不要再发现或下载。仅核验本地检查点的当前入口为：

```powershell
node src/collection.mjs resume --root .codex/private/task008-live-20261021 --db .codex/private/task009-live-20261023/state-v3.sqlite --owner redbook-local --batch cdf780fa-58f7-4cfa-94d1-6c6d706fe7b0
```

若批内仍有必须调用CLI的未开始项，额外传`--settings <现有私有settings.json>`和`--executable <现有XHS-Downloader.exe>`。不提供下载配置时不得假装已完成待采集项。已有intent但没有可靠receipt时保持待核实，不盲重采。

登录失效/验证码默认停止该批。环境恢复并已核对后，显式resume可带`--access-restored-evidence-ref <恢复核对记录引用>`；函数接口为`resume(batchId,{token,accessRestoredEvidenceRef})`。它先保存恢复依据再解除该批access block，不把未经核对的重复运行当登录已恢复。自动重试只在当前run预算内有限执行；旧无receipt请求仍保持待核实，不因新run或恢复依据绕过。

进程异常退出且执行槽仍占用时，先确认旧run及进程结束。`recover`命令必须提供`--confirmed-stopped-run-id`和`--evidence-ref`，并带root/db/owner；它不基于TTL抢锁。真实浏览器工具宿主不提供可靠PID时保持未知，需要明确环境核对，不据此宣称自动OS级恢复。恢复槽后仍须执行resume处理剩余项。

本轮私有运行配置为`.codex/private/task008-live-20261021/runtime.json`，已指向v2。原v1配置、v1源、v1备份和2项成功材料都保留。目录名日期不因跨夜改名，避免断开证据引用。22日是续作日期，不将21日真实采集改写为22日重采。
