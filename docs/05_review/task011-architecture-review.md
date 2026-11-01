# TASK-011 Architecture Review

日期：2026-10-23。执行者：Codex（主执行核对、独立Sol审查、Luna子进程验证）。档位：S2实现，授权本人真实展示按S4边界。结论：Architecture Review通过；最终C2C I2已实际DONE—ACCEPT I2 FIXES，无剩余交付阻塞，两种审查分别留证。

## 范围与依据

新增display.mjs及显示测试；analysis.decodeImage只追加实际尺寸/格式返回。沿Node标准库、现有SQLite v3、System.Drawing及官方SDK，无新依赖、schema或采集协议。011绑定pending recommendation及稳定ordinal，构建完整post和可恢复media/build引用；没有message.create、反馈、调度、投递成功归账或推荐筛选。

C2C开发前I0实际读取任务、规格和代码后给出PLAN—APPROVE WITH CONSTRAINTS。F1身份、F2关联、F3容量、F4媒体回执均逐项落实。I1独立读取实际差异和执行输出ID31，发现停止清除、成功receipt未重验、CAS后进程记录间隙和空输入误报；全部以RED复现及定向GREEN修复后送I2。

独立Sol仅接收精简包，未读private、未发送或改文件。发现invalidateMedia缺run文件造成恢复ENOENT，以及明确失败receipt落盘但checkpoint失败后保守unknown。前者两个取槽入口改为先存身份再CAS；后者按同等7字段核对后补明确失败账，非零整型平台码才允许。Sol增量只读核对与GREEN2/2后确认两项均关闭，当前无剩余阻塞或已记录的非阻塞缺口。

## 边界、数据与恢复

- 依赖为display→analysis.prepareInput/decoder→007存储。既有analysis/candidates不反向依赖display。Serena符号及引用已查，createDisplay外部引用LSP返回空时用rg补查测试和私有有界验证入口，未把空引用当无调用。
- reservation先保存UUID/ordinal及关联，随后事务登记pending身份和manifest。私有产物不是第二业务库：编号/媒体/构建均有007 checkpoint引用和hash；损坏不能凭存在认成功。单槽CAS不抢占，结束保留停止意图。
- 内容、版本、类别、候选批次及偏好/策略按不可变关系检查。原文取实际body/fields，URL从来源证据按ID核对；视频cover只出现一次。没有默认推荐理由或摘要。
- 只复用核验过的应用/材料/索引/hash/attempt成功回执。原receipt缺损阻断；未知不重传；明确失败续必要项；回执入库间隙精确补账。明确key失效只能凭原attempt和证据定向失效，不能清unknown。
- 官方30KB、10MB、尺寸限制及保守历史结构分开。未验证组合整体hold；不截断、省图、拆多条或缩图。请求含目标和uuid的最终字节检查留012发送前使用。

## 证据与限制

组合60/60及随后空输入1/1；显示最终回归见task011-testing。Luna两个独立进程验证编号/hash/0新增上传；退出73后确切recover，前2成功图复用，第3unknown阻断，第4未开始项成功。证据[子进程结果](../../.codex/task011-process-results-20261023.json)。fake解码器与实际PNG解码分开。

真实最少3条合成展示：4上传、重入0上传、API3次code0、精确回读21/21；用户桌面确认三条完整/顺序与入口正常。会话/消息ID、正文、图片与凭据仅在忽略的private，公共报告只有非私人计数。没有移动端或真实视频播放结论。

回退仅回退本任务代码/关闭私有测试入口，不覆盖旧库或删除旧回执、编号，不撤回外部消息。无push、部署、正式推送或计划；北京时间12:00不变。012仍须本卡最终审查关闭及用户单独指定。
