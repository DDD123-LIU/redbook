# TASK-013 运行宿主接线缺口

## 2026-10-25 当前宿主证据边界（Codex，I9 Review待收）

原lite ego同进程host fence和21/p2实际Pagebinder证据已由I7限定接受。隔离周期计划在完整桌面退出重开后实际自动唤起第二次；两次门控均按预期因supported tab未提供而blocked，同日批保持、slot idle且零投递。两run终态及原生计划`next_run_at=null`见`.codex/task013-i9-native-readback-20261025.json`。原计划仍配置为ACTIVE，但只有两次run且没有下一次实际派发；不应改写为PAUSED或无限运行。

这项结果关闭“有限20/21周期重入和退出重开”证据缺口，I9已`SCOPE_ACCEPT`且阻塞0；Review原文见`.codex/task013-i9-c2c-review-20261025.txt`。它不能扩展为正式runtime或业务链通过。正式candidate仍`productionEnabled=false`，其Page元数据曾指向21/p2；已接受的真实Pagebinder证明当时在缺runtime时及时阻断。桌面退出重开后没有刷新XHS Page或重绑正式候选，也没有运行正式采集、模型或投递。TASK-013最终Gate通过限于卡片规定的本地实现与有限宿主验收。

2026-10-25 最新覆盖（Codex）：原Edge缺口已由ADR-008所选lite ego同进程路线取代。每日目标改为11:15；12:50/13:05两个实际自动补测均已运行，限定自动门控/同批重入通过，不是准点或生产链通过。正式inactive候选已完整保全012原owner/外发/反馈记录，28表一致；真实20/p2视口1112×647、来源/归属/无登录提示已只读观察，候选配置已同步，未调用host或运行采集/模型/发送。C2C I6已发送待实际结论。生产计划仍NOT CREATED/ENABLED，具体提案为`.codex/task013-production-host-plan-20261025.md`；退出后周期恢复、真实业务链等未验证边界保留。下方是历史取证，不能继续把Edge导入失败或“尚未自动再入”列作当前事实。

## 2026-10-24 用户确认后的覆盖结论（Codex）

正式采集已由用户明确改为lite ego，见ADR-008。下方Edge CUA限制是原路线历史，不能继续作为lite ego的导入阻塞。公开ego nodejs可直接加载orchestrator及SQLite；用户恢复登录/视口后，真实小红书Page reload/evaluate/PageDown成功。随后真实Page经薄入口、同一隔离DB、两个独立ego Node进程返回同一blocked日批，0delivery attempt，跨轮门控证据已取得。缺runtime时blocked是实际结果，不是完整pipeline成功。隔离runtime在ego内的SDK及六factory纯构造也已验证，无材料/模型/上传/发送/监听。仍缺真实12:00计划唤起、迟到自动再次唤起和正式配置下完整运行证据；配置草案未启用。

实际证据：`.codex/task013-ego-node-probe-r3-20261024.json`、`task013-ego-page-probe-r3-20261024.json`、`task013-ego-host-first-r3-20261024.json`、`task013-ego-host-reentry-r3-20261024.json`、`task013-ego-runtime-assembly-r3-20261024.json`；Sol同进程路线审查已取得。不必仅因Edge失败回006；若支持的再次入口仍不足，带准确缺口回006，不把当前手动探针当自动唤起通过。

## 原Edge路线历史

日期：2026-10-24。执行者：Codex。状态：阻塞实际宿主接线验收；不改变原 Gate 3 的规格判断。

本轮按已确认的“桌面应用计划 → 代理 → Edge 扩展”路线检查实际调用环境。计划工具支持唤起代理，但代理仍需同时使用本地 Node 编排器和受支持的浏览器对象。当前代码通过普通函数接收 `tab`，没有另建浏览器桥。

实际检查结果：受支持 Edge CUA 浏览器选择成功。在同一执行器导入本地编排模块并调用时间门控时，返回 `process is not defined`。进一步核查标准 Node 进程模块时，执行器明确拒绝导入 `node:process`。没有尝试绕过限制。证据见 [实际探针](../../.codex/task013-host-executor-probe-20261024.json)。

因此，当前测试过的执行器不能直接承载本地 Node 协调者及其进程恢复要求。尚未证明受支持环境能把 CUA `tab` 交给本地 Node 函数。此结论只限已测试路径，不推断所有宿主路线均不可行。

## 对验收的影响

本地 Node、隔离 SQLite、注入时钟及真实模块接口测试可以继续。它们不能证明计划后台页面读取、真实12:00唤起或迟到恢复唤起。未启用持续计划，也没有以每日人工提示词替代自动入口。TASK-013 整体宿主验收不通过，不能据本地检查通过关闭整卡或自动推进 TASK-014/015。

## 返回 TASK-006 的准确问题

需要确认一个公开受支持的执行方式，使同一次宿主运行能调用本地 Node/SQLite 编排和已登录 Edge 扩展页面，并维持原批次/执行槽/检查点。不能新增自研桥、Windows常驻服务或悄悄换用另一产品浏览器。若现有公开能力不足，应按现有规格流程调整路线；本轮不直接改写已封板 Spec。

后续只补这条接线、同日周期入口及真实宿主证据。复用本轮有效本地代码、已通过测试、原 C2C `c2c_013a` 和已保存检查点，不重发成功消息。持续计划配置草案在 `.codex/task013-host-configuration-draft-20261024.md`，当前处于禁止启用状态。没有实际生产计划ID，也没有待删除的生产计划。
