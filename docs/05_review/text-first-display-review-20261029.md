> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# 正文优先与定时入口限定Review

2026-10-29，Codex。S4。用户授权：图片不得单独阻断完整正文，并同步TASK016之外的Markdown；每天11:15之外，再加仅今天06:05一次、其余配置相同。范围沿既有模块、SDK和Node标准库，无schema或依赖变更、CI、push、部署或付费API。

结论：正文优先实现、跨文档规则对齐及本地时间/互斥/额度控制限定通过；两个定时首次真实唤起尚未发生，不能标TASK016整体通过。主观Review评分：技术90、需求92、综合90；分数不替代运行证据。

src/display默认正文优先，标准eligible和body_trial均覆盖。图片缺失、未知上传或组合未验时，沿已验证正文和原入口构建明确“图片未附”payload；视频保留未读说明。unknown媒体回执仍不重传。上游图片获取失败保存partial而不丢正文。正文、来源或资格不合法仍不伪造成功。集中规则为docs/04_specs/text-first-display-policy.md，TASK003/011/012/015等旧MD加替代说明，技术规格§8/F05、TASK011和display-contract有效段落亦已修改，历史结果保留。

真实补发：原自动20请求实际30候选、23可用、chosen5，旧规则只发3。本次仅重验因反馈变化失效的2篇选择，正文与旧下载复用，不重做588/3340。首次试图替换旧pending决策被不可变身份约束拒绝，未发送或覆盖；随后关联恢复批aa961449-b340-4c60-8323-d018b185c42f正文2/2发送并精确回读，原3条不重发。原批partial3和恢复批2分别记账，不能说原事件自动5。私有task016-text-fallback-20261029/after-audit记录integrity ok及旧13条发送、10条反馈历史、13条已发索引逐行不变。

验证：正文优先新测试先RED，最终display/body-trial-images/delivery/feishu-adapter组合75/75、exit0。worker/request-dispatcher组合9/9、exit0，含独立Node争用、遗留锁不抢占、先交接再持久quota暂停、日界及06:05不提前/不跨日。日入口当前实际返回not_due/sends0。此前40/40反馈/首页组合复用，不重复计数。

原生计划：task016-11-15为每日11:15（app归一化为每周七天）；task016-06-05为今日06:05且COUNT=1，两者ACTIVE并回读。今天的例外只通过--once-20261029-0605启用，不放开普通日批11:15门槛。执行记录分开，同日共用daily_follow剩余额度和成功去重；11:15可补未满部分。机器时区China Standard Time，代码显式Asia/Shanghai。真实准点与首次全链尚待观察。

反馈正式模式无8小时截止、官方重连，仅事件驱动；关闭应用/机器后的恢复和真实中途低额度停止尚未演练。全量素材补采及旧host仍暂停/禁用，不把文件互斥描述成所有无关采集进程已完成整合。

C2C：已读技能并实际调用两连接，初为Internal error；找到未加入PATH的原安装，doctor实际全绿。用户重登ChatGPT后redbook-final workspace_info已恢复读取redbook；未获得独立ChatGPT Review，因此本文件是本地Codex Review。Serena/sequential/shrimp/code-index及GitHub Spec Kit无对应可用工具/技能，按已有规格和本地取证等价流程，未虚构调用。最新可恢复状态、监听PID和浏览器绑定见.codex/TASK-016-HANDOFF.md顶部。
