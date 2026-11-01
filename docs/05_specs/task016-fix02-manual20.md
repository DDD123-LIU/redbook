> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

> **本文状态（2026-11-01，Codex）**：下文为独立主动入口的历史方案/验证记录。该入口已撤销，不按下文创建新请求，也不再要求其真实批次验收。

# FIX02 独立主动10与当前会话接线

2026-10-29，Codex。S4。沿用用户逐项确认方案；Gate3范围稳定。使用writing-plans、TDD及ponytail，直接在原工作区续做，保留其他暂存，不复制私有账号到新worktree。

输入：本人固定飞书会话真实文本“推荐10条”（允许数字边空白）；支持“推送10条”同义词。输出request_pending/manual_follow/target10及原事件稳定command_id。除精确10外不推断其他数量；再来3条原语义不变。新事件各独立manual_follow（目标10），同事件重放返回旧批，不与daily_follow共享计数，所有入口共用已成功内容去重。

执行：沿既有dispatcher串行、quota先验、worker有限首页/正文selector/图文display/delivery/精确readback。模型Sol中档、不看图片。媒体组件等待挂载，视频明确排除，普通单条失败记录继续；平台验证全局停。当前空间通过私有配置明确绑定；丢失不认领陌生空间。每次最多40条有限候选、最多目标条数发送，不足报告实际数量，不补无限轮。unknown不重传/重发，quota失联或4/2阈值先交接停。没有schema、依赖、新产品模块。

计划：
- [x] 在feedback/homefeed现有测试增加解析、真实pending provenance、同事件重放/新事件独立/与日批分离，观察RED。
- [x] 原parser/homefeed加入manual_follow10，worker/push/listener同种类型贯通。旧自动3及日批行为保持。
- [x] 定向测试GREEN，语法检查、Review和绑定当前空间后重载监听。实际事件单独取证，不把本地测试当真实闭环。

持久在线与每日11:15属于FIX03；本次监听仍有明确8小时寿命，不冒充永久服务。真实验证需本人新飞书事件，禁止伪造事件补验收。
