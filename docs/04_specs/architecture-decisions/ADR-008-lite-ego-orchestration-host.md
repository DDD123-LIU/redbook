> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../recommendation-count-policy.md)与[最新验收](../../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# ADR-008：TASK-013 正式采集使用 lite ego

日期：2026-10-24。执行者：Codex。状态：用户明确确认选型；接线实施及验收中。仅TASK-013。

## 决策与原因

用户逐项确认阻塞处理时，明确同意正式采集浏览器统一改为lite ego。该指令取代2026-10-21的Edge扩展选型。旧Edge成功/失败证据保持历史，不追认成lite ego能力证据。日批门槛按当前technical-spec，为Asia/Shanghai每日11:15，日批10；追加关注/探索各3且只接受明确指令。

桌面应用的受支持计划唤起代理；代理调用公开的ego-browser nodejs。在同一Node ESM进程直接import现有SQLite/编排器，将公开TaskSpace.page对象直接传给原homefeed接口。没有Page跨进程序列化、自建浏览器桥、OS服务、额外依赖或第二个调度器。

每轮重新核对可用且受控的Page，使用同一绝对SQLite路径、私有root、owner和运行配置。不能持久化Page对象或临时内存token供下轮复用。用户接管时停止浏览器操作，明确继续后才接回；不新建空间绕过接管。

## 实际证据

ego Node v24.21.0成功import当前orchestrator及六factory依赖链，内存SQLite SELECT1成功，真实日期判断2026-10-24/due。真实小红书Page先有设备登录超限和0x0视口，推进失败；用户接管并明确继续后，登录超限提示消失、视口1112x639，reload/evaluate/PageDown实际返回。

没有材料采集、模型调用或飞书发送，没有启用生产计划。Page API通过不等于完整pipeline通过。

证据：`.codex/task013-ego-node-probe-r3-20261024.json`、`.codex/task013-ego-page-probe-r3-20261024.json`。Architecture Review：`.codex/task013-lite-ego-architecture-review-20261024.md`。

## 验收与回退边界

真实11:15门槛唤起、应用退出/恢复后的实际再次唤起、同进程Page进入持久批次门控分别验收。注入时钟或手动脚本不代替宿主唤起。退出、睡眠/关机、网络/登录不可用时不保证执行，不假定自动重放错过计划。

受支持再次入口不可用则将准确缺口返回TASK-006，不把每日人工提示词当自动恢复。持续计划准备具体配置和回退方式，不擅自启用。SQLite枚举、unknown先核实、成功不重发、stop保持和跨日不追欠不变。
