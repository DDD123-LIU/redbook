> **全项目当前规则（2026-11-01，Codex）**：仅保留每日自动10条＋本人飞书“再来3条”；独立主动10/20已撤销，探索不支持。每日11:15计划、最迟11:30实际启动；[统一规则](../04_specs/recommendation-count-policy.md)与[最新验收](task016-acceptance-mapping-20261029.md)优先于下文旧要求。历史数字、旧批次及原事件保持原值，历史方案与实测不作为当前执行指令。

# 项目 Markdown 与目录盘点
日期：2026-10-15。执行者：Codex。任务档位：S1，只读盘点与文档留存。

## 盘点范围及数字
创建本报告之前，仓库工作目录共有 113 个 Markdown 文件、20 个业务/文档目录。根目录本身不计入目录数；排除 .git 内部目录；包括未提交文件。仓库外的采集图片、数据库及私有分析文件不纳入本清单。
根目录 6 个，ai-delivery-kit 43 个，docs 51 个，.codex 13 个。本报告及本轮独立日志另外新增 2 个 Markdown；不回写原始快照数字。

## 当前结构
```text
redbook/
  .git/                         本地版本库，不纳入下列业务目录统计
  .codex/
  ai-delivery-kit/
  ai-delivery-kit/00_overview/
  ai-delivery-kit/01_project_intake/
  ai-delivery-kit/02_rdd_requirement_discovery/
  ai-delivery-kit/03_task_dispatch/
  ai-delivery-kit/04_prd_and_scope/
  ai-delivery-kit/05_sdd_spec_driven_development/
  ai-delivery-kit/06_ai_execution/
  ai-delivery-kit/07_quality_gates/
  ai-delivery-kit/08_evolution/
  docs/
  docs/00_intake/
  docs/01_discovery/
  docs/02_prd/
  docs/03_tasks/
  docs/03_tasks/task-cards/
  docs/04_specs/
  docs/04_specs/feature-specs/
  docs/05_review/
```

## 对照结论
### 安装入口：无硬性缺漏
AGENTS.md、PROJECT_CONTEXT.md、CODEX.md、AI_BOOTSTRAP.md、INSTALL.md、ai-delivery-kit/ 和 docs/ 均存在。43份规范包括 Overview、Intake、RDD、Task、PRD、Spec 模板、执行、质量门禁及规则回流。
CLAUDE.md 和 .claude/ 是 Claude 适配，不是当前 Codex 项目的必备缺件。ci-gate-template.md 未安装，符合用户只允许本地 AI 验证、不接 CI 的要求。
模板存在只证明规范可读，不代表业务功能和所有阶段已通过。

### 当前需求阶段产物：已建
Intake 2份、RDD 12份（六图、流程、决策、未知、校准、验证计划、汇总）、PRD 4份均已建立。
任务总表、依赖图、路线及执行提示存在；TASK-001—016 共16张。任务卡存在不代表任务已完成。
Review 目录有10份项目报告，包括正式需求审查、Gate和接入研究；不是仅留模板。

### 必须在对应阶段补齐或封板
- docs/04_specs/technical-spec.md：尚未创建；TASK-006 整合输出，Gate3/完整产品 Build 前需完成。
- docs/04_specs/api-contracts.md：尚未创建；可独立文件或在技术规格中完整定义等价契约，需覆盖模块接口、消息/反馈及状态边界。
- docs/04_specs/acceptance-criteria.md：尚未创建；PRD 和 quality-feedback 已有验收内容，但规格阶段仍需形成可执行、可追溯的整合验收契约；不能说当前完全没有验收标准。
- docs/05_review/architecture-review.md：尚未创建；架构/依赖/接口/数据模型方案定稿时需正式 Architecture Review，现有可行性研究与 RDD/PRD Review 不自动替代该项。
- 当前两份 feature-specs 是 quality-feedback.md 和 preference-inference.md：都有草案内容，尚未封板或经真实新推荐验收。缺的是关闭指标及输入边界问题，不能通过复制模板解决。
- 飞书真实展示/双向反馈、完整本地调度、收藏的日常同步/恢复等仍未全部验收。任务状态以当前 ai-task-master-list 和各报告最新部分为准；全量覆盖按用户修订后移016，不再强加为当前偏好分析前置条件。

### 模板中有、项目尚未单独创建，但不是现在的硬性缺漏
- docs/01_discovery/README.md、docs/03_tasks/task-cards/README.md、docs/04_specs/feature-specs/README.md：导航可由 docs/README.md 和任务总表覆盖，无需空壳文件凑数。
- docs/04_specs/architecture-decisions/README.md 及目录：暂无正式 ADR；出现重要架构决策时再建真实记录。
- docs/05_review/review-log.md：已有独立报告和操作日志；可以补统一审查索引，缺该文件名不等于完全没有审查留痕。
- docs/05_review/lessons-learned.md、redline-rules.md：已有 kit 中通用规范，但项目复盘/红线实例未单独建立。出现需要回流的实际条目时记录，不凭空新增约束。
- src/、tests/ 等产品目录：产品 Build 尚未启动，当前缺少这些目录不是安装漏项。不得据此跳过后续真正的实现和本地验证。

### 文档维护问题
PROJECT_CONTEXT.md、model-feasibility.md、gate-assessment.md 等保留了旧状态，并在上方或后方补充新进展。最新记录已明确历史，但读者若只看旧标题或首段仍可能误判。建议在后续对应任务更新时收敛为“当前结论＋历史记录”，不要本轮覆盖另一对话正在修改的报告。

## 验证及限制
本次扫描113份Markdown的本地相对链接，无失效链接；外部网址、绝对私有证据路径和Markdown内非链接纯文本路径未作为在线验证目标。
逐项比较 skill 安装入口、生命周期、RDD/Gate、Review 及模板目录。只有规范目录与文件存在性、相关报告状态检查，没有真实账号采集、模型、飞书或定时运行测试。
任务不命中实现、构建或发布，跳过相应执行；sequential-thinking/shrimp/code-index 在当前工具清单不可用，使用本地结构化记录及 rg/PowerShell 降级，不虚构调用。

## 完整 Markdown 清单（盘点前快照）

### .codex（13）
- agents-bootstrap-operations-log.md
- agents-bootstrap-task.md
- agents-bootstrap-verification.md
- batch20-validation-2026-10-15.md
- edge-validation-2026-10-15.md
- image-validation-2026-10-15.md
- live20-validation-2026-10-15.md
- operations-log.md
- prd-review.md
- review-report.md
- scroll-validation-2026-10-15.md
- task001-review-20261015.md
- testing.md

### 根目录（6）
- AGENTS.md
- AI_BOOTSTRAP.md
- CODEX.md
- INSTALL.md
- PROJECT_CONTEXT.md
- verification.md

### ai-delivery-kit/00_overview（5）
- lifecycle-map.md
- methodology.md
- role-and-responsibility.md
- task-complexity-routing.md
- tool-compatibility.md

### ai-delivery-kit/01_project_intake（3）
- kickoff-command.md
- project-brief-template.md
- source-materials-template.md

### ai-delivery-kit/02_rdd_requirement_discovery（4）
- rdd-gates.md
- rdd-playbook.md
- seven-step-question-bank.md
- six-maps-template.md

### ai-delivery-kit/03_task_dispatch（4）
- ai-role-matrix.md
- ai-task-master-list-template.md
- dependency-map-template.md
- task-card-template.md

### ai-delivery-kit/04_prd_and_scope（4）
- mvp-scope-template.md
- non-goals-template.md
- prd-template.md
- roadmap-template.md

### ai-delivery-kit/05_sdd_spec_driven_development（6）
- acceptance-criteria-template.md
- api-contract-template.md
- architecture-decision-record-template.md
- feature-spec-template.md
- spec-only-execution-rule.md
- technical-spec-template.md

### ai-delivery-kit/06_ai_execution（5）
- agent-workflow.md
- context-management.md
- mcp-plugin-skill-usage.md
- task-start-protocol.md
- tool-selection.md

### ai-delivery-kit/07_quality_gates（7）
- architecture-code-quality.md
- debugging-protocol.md
- final-response-checklist.md
- observability-loop.md
- review-checklist.md
- security-checklist.md
- testing-strategy.md

### ai-delivery-kit/08_evolution（5）
- issue-to-rule-loop.md
- lessons-learned.md
- prompt-version-log.md
- redline-rules.md
- rule-feedback-trigger.md

### docs/00_intake（2）
- project-brief.md
- source-materials.md

### docs/01_discovery（12）
- calibration-and-acceptance.md
- critical-unknowns.md
- data-map.md
- decision-map.md
- decisions-and-open-questions.md
- feasibility-plan.md
- output-map.md
- rdd-status.md
- risk-map.md
- scenario-map.md
- user-map.md
- workflow.md

### docs/02_prd（4）
- mvp-scope.md
- non-goals.md
- product-prd.md
- roadmap.md

### docs/03_tasks（4）
- ai-task-master-list.md
- dependency-map.md
- task-execution-prompts.md
- task-roadmap.md

### docs/03_tasks/task-cards（16）
- TASK-001.md
- TASK-002.md
- TASK-003.md
- TASK-004.md
- TASK-005.md
- TASK-006.md
- TASK-007.md
- TASK-008.md
- TASK-009.md
- TASK-010.md
- TASK-011.md
- TASK-012.md
- TASK-013.md
- TASK-014.md
- TASK-015.md
- TASK-016.md

### docs/04_specs/feature-specs（2）
- preference-inference.md
- quality-feedback.md

### docs/05_review（10）
- automation-gap-assessment.md
- collection-feasibility.md
- feasibility-spec-review.md
- feishu-feasibility.md
- gate-assessment.md
- local-runtime-feasibility.md
- model-feasibility.md
- rdd-prd-review.md
- task-roadmap-review-20261015.md
- xhs-downloader-assessment.md

### docs（1）
- README.md
