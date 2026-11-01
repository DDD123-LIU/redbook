# ADR-006 投递、反馈和人工偏好的证据边界

日期：2026-10-24。执行者：Codex。状态：已接受。范围：TASK-012，Schema v3。

Sol四项Architecture Review发现及C2C I1/I2全部发现已修，I3 DONE—ACCEPT；最新投递/集成22/22，前阶段有效证据复用。详见task012-review-20261024.md及交付报告，不扩展到013/长期运行。

## 决定及理由

复用现有delivery_attempt、delivered_content、feedback_event/current/history、outbox、checkpoint和单槽，不新增协议、数据库表、依赖、队列或服务。发送、查询和长连接使用已有官方飞书SDK。程序只提供普通函数，正式编排留013。

发送前的本地许可、意图和独占claim必须在SQLite事务中复核。claim保存dispatched_at及revision，不能仅用intent→intent状态CAS。外部SDK调用留在事务外；平台结果与本地提交不能宣称原子。成功receipt先确切落盘，再归账。claim后没有可验证结果则unknown，不能以超时或进程结束推出未达。

查message_id优先于历史扫描。无ID核实只读本人目标及原时间窗，要求完整分页、应用发送者、完整payload、稳定编号和唯一message_id。回执文本包含唯一outbox标记，不能只凭常见“已记录”字符串匹配。查询零匹配不证明未达。平台uuid仅1小时去重，本地成功索引及unknown隔离承担跨日防重责任。最后本地检查与外部派发仍存在竞态，已可能派发的结果按原批实际版本核实。

反馈始终归并到首次成功内容身份。不同推荐编号或消息是定位别名，不是第二份有效评价。业务event/current/history及outbox同事务，保存成功与回执成功分别判断。不同值更正要求revision，迟到时间只作为辅助保护；歧义先澄清。无反馈、看过、赞、踩和取消收藏不混为一类。

明确偏好使用既有不可变preference_version和current指针，新增显式manifest分支。父模型根仍核验原完成凭据，人工子版保存真实事件、操作及父pointer，不伪造模型完成。发布只修改明确指令并保留父推断/支持内容。事件、人工版本、指针和回执待办事务内提交，父版变化则回滚重读。单次评价只保存偏好更新依据，不静默覆盖整个偏好。

## 权衡与恢复

SQLite保证本地事务，不能保证外部exactly-once。若外发结果和本地证据均丢失，系统可保留unknown并继续核实，但不能承诺自动消除未知。确切回执产物、hash和checkpoint提高受控中断恢复能力，不能把任意文件存在当成功。

没有持久调度或正式运行；listener由调用方显式启动并停止，退出前等待已接收handler完成。回执故障不回滚评价。备份不撤销平台消息。敏感payload、会话标识、消息ID与凭据保存在Git忽略区，公开报告只保留计数/状态/证据类型。

## 验证门槛

独立Node进程争用同attempt、claim前后退出、receipt后归账前退出，均检查真实外部适配调用次数。反馈覆盖保存失败可重试、事件并发、修订冲突、迟到、查询、别名归并、保存后回执前退出和回执结果后提交前退出。平台fake契约与真实本人事件分开记录。最终C2C和Architecture Review结果须另查，不由本ADR预先宣布通过。
