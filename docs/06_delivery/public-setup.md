# 公开版配置说明

2026-11-02，Codex。

公开仓库提供源代码和测试，不包含账号配置、数据库、私有偏好或平台原文。请先运行本地测试，不要直接启用真实投递脚本。

## 宿主配置

`examples/host-config.example.json` 对应 `src/orchestration-host.mjs` 的读取契约。所有路径必须为绝对路径；运行时模块须导出 `createRuntime({config, store, now})` 并返回实际接线对象。示例本身不提供运行时实现，`productionEnabled: false` 会阻止执行。

## 当前 TASK016 运行脚本

`.codex/task016-auto-worker.mjs` 及其依赖保留原目录。真实链路使用 `.codex/private/task016-browser-session.json` 和 `.codex/private/task013-production/` 下的状态与配置；该目录必须在本地建立，不能提交。

飞书运行脚本从本地 `runtime.json` 的 `bindingPath`、`credentialFiles` 读取绑定及凭据。凭据字段包括 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID`。这些字段名是配置契约，不代表仓库提供可用账号或权限。应按源码同时准备本人身份、聊天权限、偏好基线及已有状态，不要用演示值伪造绑定。

部分脚本仍引用 `C:/Users/YOUR_USER/...` 或开发工作区路径。实际启动前须按本机安装位置核对，不应把 README 的源码入口当作一键部署命令。Ego Browser 提供的 `taskSpace` 等函数需要在它的运行环境内调用。

## 依赖

核心：Node.js 24.19.0（本次验证版本，含 `node:sqlite`）。飞书：`@larksuiteoapi/node-sdk`、`axios`。图片解码见 `src/analysis.mjs`；图片准备脚本可能调用外部转换工具。没有真实图片工具、模型或浏览器时，使用测试注入的合成适配器进行隔离验证。

公开发布只做本地测试和仓库操作，不安装计划、不调用真实模型、不发送飞书消息。
