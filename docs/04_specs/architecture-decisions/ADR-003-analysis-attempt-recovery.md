# ADR-003 不可变分析尝试与损坏重分析

日期：2026-10-23。执行者：Codex。状态：方案经C2C c2c_009a开发前增量架构审查支持；实现与验收见TASK-009 Review。

## 问题与决定

v2的analysis_success_input_uq限制同材料/输入/提示只能一个complete；analysis行又不可更新/删除。成功输出后来损坏且无有效副本时，无法保留旧记录并追加新有效分析。不能伪造提示版本、输入hash或材料repair绕过。

采用v3，只把该索引替换为analysis_complete_lookup_idx非唯一查找索引。analysis_id、外键、不可变触发器和材料repair约束不变。有效缓存从新到旧逐条核验，任何有效候选存在则不调用模型。所有候选无效时保存旧ID/路径和失效原因，独立新attempt落盘。单执行槽CAS及入库前事务复核约束执行者。

## 升级与回退

空库初始化v3。upgradeStoreV1保持显式v1→v2原义；内部不能用最新常量错标v3。upgradeStoreV2ToV3(source,destination,{backupPath})确认源库静止、版本及完整性，创建新路径v2备份，在独立副本变更索引并核验外键/完整性后发布新路径v3。openStore拒绝隐式升级v1/v2。

源和备份不改，原材料/输出不删。restoreStore(backup,newPath,2)可恢复v2取证，当前openStore仍要求显式升级。升级/备份继承硬链接文件系统限制；失败不发布目标。迁移前调用者必须确认执行者已停，SQLite检查不是OS级进程停止证明。

## 权衡与验证

数据库允许同输入多个complete，但不表示可以重复消耗额度。分析入口负责有效缓存、CAS、receipt和不可变attempt；非协议写入者不获绝对防重复保证。保留失败/损坏历史，不把其当成功缓存。新增隔离迁移、损坏重分析、有效缓存遍历、007/008回归；旧历史结果不回写。

来源：src/schema.sql、src/storage.mjs、.codex/task009-analysis-attempt-decision-20261023.md、.codex/task009-c2c-architecture-delta-20261023.txt。
