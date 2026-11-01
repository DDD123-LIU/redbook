# TASK-011 平台依据与待验边界

2026-10-29，Codex，用户最新规则：[正文优先推送](../04_specs/text-first-display-policy.md)。图片缺失、获取/上传失败、unknown或图文组合未验证，不再单独阻断已通过筛选且可验证的完整正文；明确标注图片未附及原因，保留标题、作者和原入口，不改摘要、不截断，不假称图片完整或已分析。此规则覆盖下方旧“媒体失败整篇blocked/hold、不允许降级”的当前运行解释；原实验、历史验收及未知媒体不盲重传事实保留，不追溯改写为新规则通过。采集和模型分析的材料完整性要求不变。

日期：2026-10-23。执行者：Codex。本节是能力依据，不是客户端通过记录。

使用lite ego实际读取官方页面DOM。web抓取仅标题；exa工具不可用，先用web检索官方入口，再用ego读取。原页面文本留private，不提交页面示例及会话参数。

- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)，页面更新时间2026-04-10：富文本请求体不超过30 KB。图片先上传再引用key。构建时计算UTF8序列化content与包含receive_id/uuid的实际请求体；后者在012发送前再核验。保守按30000字节，不把字符数当字节数。
- [发送内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)：post支持段落、text/img/a；图片独占段落。text的un_escape默认false，保留原文，不走Markdown。未找到post总组件数的明确上限，不能挪用卡片200组件限制。
- [上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)：非空且不超过10 MB；GIF不超过2000x2000，其他图片不超过12000x12000。保守按10000000字节。不压缩、不缩图、不文件替代。超出返回display_blocked并保留原材料。

TASK003的6000字符/3图和TASK004的744 UTF16/9图是分立样本。未知组件能力采用历史已验证结构范围，不推出任意长文+9图通过。真实客户端验证另记；移动端/视频播放仍未验。

2026-10-29最新补证：见[长文九图实测](task016-display-boundary-20261029.md)，有图正文支持域扩至6000 UTF16、9图，原分立样本事实保留。
