# TASK-009 图文分析与偏好运行契约

日期：2026-10-23。执行者：Codex。依据technical-spec §6、TASK-009和ADR-003。实现：src/analysis.mjs；Node24标准库，无产品依赖或付费API。

## 入口与输入

`createAnalyzer({store,root,owner,executable,proxy?})`复用007的v3存储。`run({batchKey,materialIds,promptVersion?,contextVersion?,modelRequested?,summarize?,explicitInstructions?,explicitFeedback?,coverage?})`只处理显式、非空、无重复材料ID。materialIds是007内部材料UUID，不是平台ID。repair材料按普通根/H/内容和实际输入匹配缓存，不因物理ID变化重跑。

root为Git外或`.codex/private/`内私有目录。store库、正文及媒体沿008引用；默认不扫描全部材料、不采集或下载。`prepareInput`核对实际正文文件hash；008的canonical JSON拆出description为正文，并完整保留title/tags/author等字段。普通文本原样输入。图片读取实际字节hash并System.Drawing解码，按连续索引附加。封面存在则输入，视频不播放。无收藏时间保持null；首次观察、发布时间和真实收藏时间分别存档，不伪造近期兴趣变化。

实际模型请求只传正文、来源字段、图片状态/顺序及契约字段；路径、物理repair ID和抓取时刻不作为模型语义输入。input_hash覆盖这些实际内容、正文文件hash、图片实际/声明hash及缺失状态、媒体范围、完整提示词、Schema、提示/上下文版本和请求模型。调用前复制附件并核对字节；input.json/request.json记录实际正文和附件路径。请求模型默认gpt-6.1-sol，服务端实际快照无法核实则unknown。

## 范围与输出

`body_and_images`：实际提供完整声明图片；`body_and_partial_images`：仅可读子集或材料部分；`body_only`：仅正文。`video_body_and_cover`/`video_body_only`均不含视频动态画面与音频。附图交付不保证文字逐字正确；每图另有readability，不可读、缺失、损坏分别保留。

output.json分为summary、逐图images、direct_evidence、inferences、actionable、uncertainties和枚举media_scope。正文直接证据须逐字命中本次正文；图片证据须引用实际附件索引。图片中的事实仍是原帖证据，不等于外部事实核实。schema/ID/顺序/完成凭据合格不等于品味或视觉理解质量已经全面通过。

可靠来源删除状态与本地材料有效性分开。已有成功采集且字节/hash有效的离线材料仍可分析，source_state独立保存，不重新采集、不推断不喜欢。缺失/损坏的实际输出统一记非成功，receipt恢复不因ENOENT反复抛错，不盲目重复CLI。

## 缓存、版本与检查点

成功需exit0、恰一个turn.completed、无失败事件或工具执行、JSON与ID/逐图/正文证据有效。缓存复核input/receipt/output文件hash、输入hash、来源根与H、结构及完成证据。只存在同ID或文件不命中。成功、失败和损坏尝试独立目录保留；v3允许同输入追加修复分析，旧行不改。

每步生成不可变私有snapshot，checkpoint关联snapshot及hash、pending/success/failure/processing，单执行槽CAS防止两个协议执行者并发。receipt先落盘再入库；归账中断后通过原attempt ID恢复，不重复模型。缺receipt且旧进程或结果不明保留unknown；不按TTL或PID存在猜测已结束。

偏好输入为本次显式有效分析集合、每份ID/hash/结果、明确指令/反馈、coverage、汇总契约及模型。未变且已发布输出校验有效则跳过；变化只重做汇总及必要的新帖。不能把预设主题当全部兴趣；收藏/删除/采集失败/取消不等同喜欢或负反馈。明确指令另存并优先；推断主题一律long_term=false，不能自动晋升。置信为定性等级，不伪装统计概率；无可靠收藏时间不做时间衰减。

完整汇总校验后，私有manifest关联输入集合、分析版本、父版、生成UTC时间、契约及限制。preference_version与当前指针checkpoint在同一SQLite事务发布。空、坏JSON、额度阻断、部分输出不替换当前版。偏好产出不证明推荐95%，全量和业务验收留016。

## CLI、恢复与停止

私有配置含`db,root,owner,batchKey,materialIds`及上述run选项；executable为官方CLI路径，proxy仅复用已有配置，不能含凭据。登录沿官方ChatGPT订阅；`--ignore-user-config`、移除子进程API key环境变量，无付费切换。每次CLI默认600秒单次超时，无全批总时限。额度/认证明确信号阻断后续；unknown错误不猜恢复时刻。当前入口不自动购买、调度、发通知或飞书。

```powershell
node src/analysis.mjs run <私有配置.json>
node src/analysis.mjs recover <私有配置.json> <确已停止的run-id> <核实记录引用>
node src/analysis.mjs resolve <私有配置.json> <确切attempt-id> <进程及结果核实记录引用>
```

正常恢复重用同配置，自动复核成功项并跳过；failed/partial/blocked在条件恢复后只补必要项。额度未恢复不要重复运行。slot遗留需先确认旧父/子进程已结束再recover；存活或状态未知拒绝接管。unknown的resolve仅记录确切核实：有receipt回到重验，没有receipt记确知未完成，再由run续作；不会把未知当成功。存在无效receipt的明确失败由原receipt重验归账，不伪造成功。所有原尝试保留。

每次模型前保存intent、输入及处理中snapshot，启动后保存PID/启动时间/可执行路径/attempt绑定。PID复用时保守拒绝自动接管，需要进一步环境核实；不声称OS级完全自动恢复。中断保留本地文件；当前CLI没有异步“暂停”命令，外部停止后由上述入口核实恢复，不虚构在途撤销。

本轮准确配置路径及最终结果见`.codex/task009-testing-20261023.md`；不得运行全部收藏。私人正文、图、分析、偏好和完整CLI日志不进Git；仓库仅合成夹具及脱敏计数。
