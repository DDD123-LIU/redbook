> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# 长文多图边界实测

2026-10-29，Codex。用户确认本轮只验证显示/容量，不调用看图模型或进行质量评估。

真实本人飞书消息：6000 UTF16中文正文＋9张320×180编号测试图，请求19255字节。send和同message_id精确回读均succeeded，message_id=om_x100b6117f49300acce9b10dc8fdd66f。用户复制回的6116字符消息文本含6000字符完整正文，逐字包含比较true，BEGIN6000/END6000/END-OF-MESSAGE全部存在。Windows飞书实际画面观察图1—9升序、正文末尾及消息结束标记，分段截图保存在私有目录。非推荐测试，不计日批20，不写喜好或推荐主库；9图为程序编号夹具，没有图片语义模型调用。

证据：.codex/private/task016-display-boundary-20261029/send-intent.json、send-result.json、readback.json、user-copy-verification.json、desktop-verification.json及4张desktop截图。用户粘贴原文来自D:/Codex/home/attachments/d6109c88-0c6c-4503-9856-60f19e589c95/已粘贴的文本.txt。

据此将正式已验证组合从有图≤744扩到正文≤6000、图片≤9，继续保留请求字节/组件边界；超过此域图片仍可降级正文，不将6000/9称平台硬上限。先将20种长度×图数纯格式组合测试改为新预期，原实现于745/1出现RED，再修改capacity规则。display＋body-trial-images回归33/33、exit0。未知上传不重传、缺图发正文、视频未读等原行为保持；未重跑无关旧测试。

限定Review通过：实际发送、精确回读、用户正文复制和Windows截图分别有证据；未验证手机客户端/网页版、任意更长正文、任意图数或所有设备。两次前台观察被用户切回Codex影响，未把遮挡截图当飞书通过证据；取得用户保持前台确认后逐段完成九图核验。模型看图、推荐质量与首次定时运行仍不属于本轮通过范围。
