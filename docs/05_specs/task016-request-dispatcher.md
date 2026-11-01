> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](../05_review/task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# TASK016 飞书请求自动派发

日期：2026-10-28。执行者：Codex。S2。Gate3：用户已明确继续，父任务授权最小dispatcher；真实worker和接线由父任务负责。

同feishu-listener.mjs新增createRequestDispatcher({store,owner,feedback,execute,quotaProbe,now,onResult})。返回enqueue(request)、drain()、stop()。feedback.pendingRequests提供原有验真请求，不解析新命令。仅request_pending执行，preference_pending跳过。稳定command_id/event_id保留。单队列串行；stop拒绝新任务并等待已接纳队列，drain等待队列。

每次执行前检查现存batch(owner,command_id)，任何状态含partial均不启动。checkpoint先持久化intent再execute(request)，再保存真实结果；重复事件和重启不再执行。旧intent表示不确定，记录unknown，不自动重试。失败保存真实返回或错误，不自动重试。quotaProbe返回reliable:true、shortRemainingPercent、weeklyRemainingPercent；任一缺失/非数值/不可靠，或短周期<4、周<2则quota_blocked并停止本dispatcher后续执行。该请求已留痕不自动重启，恢复由父任务显式处理或新用户命令。

本实现不发消息、不操作真实库。测试用隔离SQLite与注入execute/quotaProbe，覆盖串行、重复事件、重启、partial既有批次、额度、失败与stop/drain。不重复旧全流程。
