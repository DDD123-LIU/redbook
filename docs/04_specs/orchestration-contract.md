# TASK-013 编排接口增补

## 2026-10-26 TASK015发现的逐条投递状态修复（Codex）

同一批有多条展示结果时，每条prepare/reprepare前先保存当前推荐的delivery running检查点。上一条成功记录继续保留，不能用它的succeeded状态表示下一条正在准备的请求。真实未派发intent提交后崩溃仍走原有退出/空槽/身份/hash核验、取消旧intent及明确continue路径，不放宽已派发或unknown恢复门禁。不承诺覆盖running标记写入后、intent创建前的任意指令点崩溃；缺证明仍为recovery_required。TASK015合成回归与Review另留证。

## 2026-10-25 I4 多轮明确继续的内部证明细化（Codex，方案边界接受、待实现验证）

本批仍有效的原取消proposal不能因为跨过一个中间协调代而丢失。只明确continue允许重备；普通daily保持stop或explicit_continue_required。复用现有command/main checkpoint逐代证明从原取消协调者到当前明确指令的授权链，不新增公开参数或Schema。

每跳owner/batch不变，generation严格相邻，父run精确等于子head.continued_from；子代持久command的stage/input/output hash与身份必须一致，当前指令ID也须精确匹配。父代取确切身份最新returned/inactive、pending空的head，阶段/worker证据仍完整。链终端必须仍是原批最新head及当前generation，不接受跳代、跨批、活动父代、缺命令、歧义或链外后继。rowid用于持久顺序，不以合成时钟判断先后。

每个推荐以所有状态中的最新attempt判断义务；已有成功、intent/unknown或已派发后继不能退回旧cancelled记录重备。原rec/UUID/ordinal/build/payload/取消证明、版本与预算和唯一许可不变。坏链或坏proof返回recovery_required并带原attempt ID，不先建立新代，不静默跳过再补新候选。普通入口需要确认时报告最新静止代，同时保留原attempt IDs。

新增谱系核验使用DB/内存；文件、阶段与worker证明先核，事务中对每代main/command/phase CP ID与hash、批/槽/attempt/recommendation快照及无后继条件重核。具体既有事务文件读取边界沿I3 Review如实保留，不声称整个继续路径无FS。方案依据task013-i4-lineage-plan-20261025.md，须实现delta AR与新RED/GREEN后才能判通过。

## 2026-10-25 I3 契约映射（Codex，独立Review中）

本轮仅细化既有停止/继续和未决投递状态，不改Schema或封板业务范围。`continueBatch`的原停止身份来自该owner/batch/run/generation的历史静止checkpoint；另核最新全局head静止、空槽、原批无后继和未变代次。不能用其他批的最新head替代原证明。

原批存在经核实取消且等待明确继续的推荐时，普通每日入口返回`blocked / explicit_continue_required`及原身份，不增代次或建立新head。坏取消证明为recovery_required。明确continue仍沿TASK-012原接口保留rec/UUID/ordinal，创建新的attempt，不复活旧attempt。

业务attempt的`intent`不属于编排阶段状态。未派发intent的编排阶段可记blocked，result保留attempt_status及原ID；业务状态不变。仅有完整静止/未派发证明且事务快照仍匹配的确切旧intent，可让当前无下游派发的blocked编排静止。unknown/已派发/活动执行者不使用此窄例外，恢复入口仍按原严格证据。

新增与受影响定向验证10/10 EXIT0，源码2AEFE466，见本轮输出；该结果不替代AR/C2C或真实宿主验收。

2026-10-24路线修订（Codex，用户明确确认）：正式采集统一lite ego，详见[ADR-008](architecture-decisions/ADR-008-lite-ego-orchestration-host.md)。代理使用公开ego-browser nodejs，在同进程import本地编排器并传入受控Page；每轮重新绑定Page，DB/root/owner保持一致。原Edge限定改为历史。计划入口只进入ensureDailyBatch；不复制业务逻辑、不建浏览器桥、不启用生产日程。真实宿主及恢复入口须独立取证。

日期：2026-10-24。执行者：Codex。状态：实现契约增补，配合 [ADR-007](architecture-decisions/ADR-007-orchestration-fencing.md)。本文细化 technical-spec v1.0，不改写封板业务原文；实现和验收仍须独立 Review。

## 入口

```js
dueStatus(now) -> { status: 'not_due' | 'due', businessDay: 'YYYY-MM-DD' }

createOrchestrator({
  store, root, owner, appRef, targetRef, runtime,
  now = () => new Date().toISOString(), uuid
}) -> { ensureDailyBatch, run, requestStop, continueBatch, recoverCoordinator }

ensureDailyBatch({ tab, commandId, requestText, direction })
run({ kind = 'daily_follow', tab, commandId, explicitRequest, requestText, direction, coordination })
requestStop({ batchId })
continueBatch({ batchId, commandId, confirmedStoppedRunId, evidenceRef, explicitRequest, direction })
recoverCoordinator({ confirmedStoppedRunId, evidenceRef })
```

`now` 是工厂级时钟函数。所有模块共享此函数，并在门控、阶段提交和午夜复核时实时读取；不能把 run 开始的时间戳缓存到整轮任务。所有日界使用 `Asia/Shanghai`。宿主通过 `run` 传入受支持的已绑定 tab；没有 tab、CLI、模型、媒体上传器或投递 transport 等必需能力时，入口返回明确 `blocked`，不得伪造后台浏览器访问成功。每轮从入场到退出使用同一个 coordinator identity；modules 在获批 admission 后创建，不用 setter 改变已创建实例的身份。

当前实现中 `ensureDailyBatch` 是 daily `run` 的别名，会进入整个pipeline；缺少运行能力时返回 `blocked` 和已存在的 `batch_id`。追加和探索调用必须给稳定 `commandId` 及原始 `requestText`；探索还要给 `direction`。`continueBatch` 返回一次性 `coordination` token，宿主随后将其原样传入 `run`；token只可消费一次。

`requestStop` 持久设置批次 stop 并使当前阶段请求停止。它不因 slot release 而清除此标志。`continueBatch` 必须有明确的 continue command，并指向同owner、同批次的正常静止head；常驻宿主PID可以继续使用。普通 `run` 重入不恢复。`recoverCoordinator` 需要 `confirmedStoppedRunId` 和 `evidenceRef`，且必须核实协调者与所有派生阶段进程都已退出。缺少证据时保留活动头并返回 `recovery_required`，不能用新 run 重置。

`runtime` 保存现有模块需要的配置：collection CLI、analysis 与 selection 执行器、display client/upload 函数、delivery transport 和版本核验函数。编排器直接构造既有 `createCollector`、`createAnalyzer`、`createCandidates`、`createHomefeed`、`createDisplay`、`createDelivery`；它不以注入的阶段回调替代模块调用。

## 协调者身份和全局头

协调者身份为：

```js
{ owner, batchId, runId, batchGeneration }
```

`batchGeneration` 只用于批次及协调者 fencing。阶段模块现有的 `{ owner, runId, generation }` 是独立的 `execution_slot` token，不能混用。

现有 `checkpoint` 表中使用唯一约定的 stage `orchestration:main` 作为全局协调头。检查最新记录时不按 owner 过滤。`pending_ids_json` 含本轮 `runId` 表示协调者仍活动；空数组表示它已确认静止。一个仍活动的全局头阻止无 coordinator token 的旧入口领取新槽，即使当前 `execution_slot` 暂时空闲。

`store.assertCoordinator(coordination, { now, accountingOnly = false })`：

- 正常执行必须匹配最新活动协调头及批次 owner、generation、状态和 stop 标志。
- `daily_follow` 只允许在输入时钟对应的上海业务日继续派发。
- 没有 coordinator 时，仅当全局头不存在或已静止，既有非编排入口才可继续。
- `accountingOnly` 供既有 attempt 的 receipt、成功、失败或 unknown 归账使用。它允许 stop、closed_day 或协调头换代；调用方仍须验证原 attempt 身份、哈希和 receipt。此模式不得新建意图、触发外部工作或推进下游语义。

`casSlot` 增加可选 `coordination`。新领取在原 CAS 事务内调用正常 coordinator 检查，并把对应 `batch_id` 写入 slot。slot owner 必须等于 coordinator owner；显式 `batchId` 必须与 coordinator 批一致。释放仍只核阶段 token，使停止或跨日后仍能确认退出。

head proof 必须绑定 owner、batch、run、batch generation、active/pending一致性、进程PID、进程实例ID、启动时间、invocation状态和worker引用数组，并通过既有 `output_hash` 校验。字段缺失、身份错配或哈希不符时，storage guard失败关闭。

## admission 与阶段交接

`ensureDailyBatch` 先判断上海业务日和11:15门槛。11:14:59返回 `not_due`，不建当日运行批；恰11:15及之后允许门控。11:15起缺runtime时，单独以既有事务及日键保留唯一blocked批身份；这不是执行许可。能力具备时，首次建批和admission在同一 `BEGIN IMMEDIATE` 内重新读取全局协调头、slot、批次及停止/日界条件，原子创建或更新批次许可与slot；不先留下pending运行批再另取槽。若该许可事务失败，首次批/head/slot一同回滚；已存在的blocked批保留原身份且不变成假成功。追加/探索只接受稳定 `commandId` 和明确请求，目标各3；探索缺可验证direction时持久blocked，不猜测方向。

admission 同事务更新允许继续的批 generation、写活动协调头、CAS admission slot。事务失败时全部回滚。随后释放 admission slot；协调头保持活动状态，阶段模块按原有方式短时领取和释放单例 slot。重复宿主唤起发现活动协调者时返回 `busy` 或 `recovery_required`，不得抢占。

每个实际阶段模块用同一 coordinator identity 构造。阶段 claim、外部派发和会发布新下游语义的事务必须在各自事务内重核 fencing；不能只在 orchestrator 调用前后检查。外部 CLI、浏览器、模型、文件和发送操作全部在 SQLite 事务外。

标准 pipeline 顺序为：`homefeed.refreshHomefeed → candidates.run（调用现有 collection/analysis/selection）→ display.buildBatch → delivery.prepareDelivery/sendPrepared/reconcileDelivery`。每步只处理该批尚未完成的唯一成功预算。候选不足记录 `shortfall`，不无限刷新。实际 `delivery.sendPrepared` 的 transport 发送次数必须可审计；unknown 先沿 TASK-012 原 attempt/outbox 核实。

## fencing 与迟到归账

过期 coordinator 或已停止/过日批不得获得新的阶段槽、外部派发许可、媒体上传许可、候选决策或偏好发布许可。stop 不因阶段 slot release 而清除。普通每日入口不清 stop；只有明确 continue 并确认旧执行者和派生子进程均退出后才允许换代。

已经派发的 attempt 仍按原身份归账。真实晚到的 receipt、成功、失败或 unknown 可以在 stop、closed_day 或协调者换代后追加；该归账不能恢复旧批运行状态，也不能推进旧流程的下游阶段。午夜后的成功归原批并保留真实 `returned_at`，不抵扣新日目标。

delivery 保留既有空槽、`expected_generation` 和 `attempt.dispatched_at` 派发线性化点。派发 intent 固定原 coordinator 身份；恢复旧 intent 不能改绑新 coordinator。已派发 attempt 的 reconcile/recover/account 不要求当前批仍可派发。

## 宿主边界

桌面计划/heartbeat 可按受支持能力周期调用同一个 `run` 门控，并把 Agent 已绑定的 tab 传入。宿主配置是否已创建、是否真实在当前11:15门槛唤起、后台页面是否可读、错过计划后是否有下一次受支持入口，均与合成数据库测试分开报告。没有本地证据时保留未验证或 blocked；不增加常驻服务、计划外浏览器桥、付费 API 或生产计划。

## 当前验收边界

2026-10-24，Codex，r4实现增补：阶段审计与真实执行者/子进程证明已接线；缺失退出证明仍保持 `recovery_required`。未派发 intent 通过 TASK-012 的取消和重新准备接口恢复，禁止编排器直改投递台账。准备提交后、发送前的真实 Node 中断恢复已有隔离测试证据。以上仍须 C2C I2 独立审查，不能当作整卡验收。

部分继续时，`candidates.run` 可接收 `excludeCandidateIds`。编排器仅传入原推荐绑定、哈希和身份已验证的缓存 proposal 的 candidate IDs。过滤先于 `maxCandidates`，其余候选沿用原处理。该参数不授予发送权限；最终版本、状态、预算、stop、generation 和 unknown 检查不变。

正式浏览器按用户确认切换为 lite ego，见 ADR-008。真实 Page 和手动独立进程门控探针已记录；真实北京时间11:15门槛唤起和宿主自动再次唤起仍未验证，生产日程未启用。历史 Edge 导入失败保留为历史证据，不能代表 lite ego 当前结论。
