# ADR-007：TASK-013 使用全局协调头保护阶段交接

日期：2026-10-24。执行者：Codex。状态：按 Sol Architecture Review 和 C2C I0 的受控 Build 方案采纳；实现审查待完成。

## 背景

TASK-013 要在每日门控和恢复入口协调多个既有阶段。`homefeed`、`collection`、`analysis`、`candidates` 与 `display` 会各自领取单例 `execution_slot`。若 orchestrator 整轮持槽，阶段会因槽繁忙而无法运行。若只检查当前批 `running`，追加/探索批、其他 owner 或跨日关闭仍可能在阶段空档取得全局槽。

## 决定

1. 复用 Schema v3 的 batch generation、单例 `execution_slot` 和通用 `checkpoint`，不新增表或 schema 迁移。
2. `checkpoint.stage='orchestration:main'` 保存全局 coordinator head。head 仍有 pending run 时，唯一 coordinator 尚未确认退出。
3. 批次 generation fencing 批身份；全局 head fencing owner/run/batch。阶段 token 仍使用各模块原有 slot generation。
4. `store.assertCoordinator` 和 `casSlot(...coordination)` 提供共同存储护栏。实际阶段模块在 claim、dispatch、下游语义提交事务内重核 coordinator。
5. coordinator 只在 admission 阶段短时领取 slot，然后释放；全局活动 head 保护阶段交接空隙。
6. delivery 保留空 slot、expected generation 和 dispatched_at 一次性派发合同，不强行套用阶段 slot claim。
7. 新工作受 stale/stop/cross-day fence 限制。已派发 attempt 的 receipt/终态归账仍可按原 attempt 追加，且不推进下游工作。
8. pipeline adapter 调用真实现有模块。宿主把受支持的 browser tab 传入；不以回调 stub、私造浏览器桥或本地合成测试冒充宿主能力。

## 影响

- 新旧 coordinator 不能因暂时空槽而并发；无法证明旧执行者及其子进程退出时必须保留 `recovery_required`。
- 需更新六个 factory 的窄配置和需要同步的关键事务；既有独立使用路径保持原配置形态，但活动全局 coordinator 存在时无 token 入口被拒绝。
- late result 的归账和下游推进必须分开；归账不能清 stop、重开 closed_day 或重算新日目标。
- 合成测试证明本地状态机；真实宿主触发和 Edge 页读取另行验收。

## 拒绝的方案

- orchestrator 整轮持有全局 slot：会与阶段模块自己的 claim 冲突。
- 只以 `batch.status='running'` 防重：不能保护追加批、探索批、其他 owner 和跨日空档。
- 单纯在阶段调用前后检查 coordinator：不能关闭 claim/dispatch/语义提交中的竞态。
- 增加独立锁表、调度服务或浏览器桥：现有 schema 和受支持宿主路线已足以表达本地准入与浏览器输入。

## 证据

- 封板范围：[technical-spec.md §3–4/§10/§12](../technical-spec.md)
- 既有存储：[storage-contract.md](../storage-contract.md)
- 既有投递：[delivery-feedback-contract.md](../delivery-feedback-contract.md)
- 开发前分析：[TASK-013 Sol Architecture Review](../../../.codex/task013-sol-architecture-20261024.md)
- 实现与验收证据：待 `.codex/task013-review-20261024.md` 和本地测试记录补充。
