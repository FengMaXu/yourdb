# 企业级数据智能体 (Enterprise Data Agent)

支持 `Web UI` 与 `Electron` 桌面端的数据智能体，面向企业内部的数据查询、分析推演、报告生成和工作区协作场景。

## 项目简介

本项目基于 Pi-Mono 架构构建统一的 TypeScript Agent 运行时（`@data-agent/runtime`），将自然语言请求转化为可执行的数据任务链路。系统覆盖问题理解、上下文装配、工具调用、SQL 查询、安全校验、结果加工、图表生成与分析交付等关键环节，适合企业内部数据服务、探索式分析和可复用的数据工作流搭建。

## 当前能力

- 支持同一任务下的多会话、会话恢复、工作区映射与 Pi JSONL transcript 持久化
- 支持流式对话、工具调用展示、`stop` / `steer` / follow-up 协作流程与澄清问答
- 支持工作区文件上传、下载、附加提问和会话级文件管理
- 支持知识库（BM25 检索）、Skill、MCP 工具与本地工作区协同
- 提供 Electron 桌面端（TypeScript 主进程 + IPC 版本化通道）与 Fastify Web Host
- 内置 Python 数据运行时 pack（分析/可视化），通过 MCP 服务器访问 MySQL/PostgreSQL/SQLite
- 看板：静态 HTML 看板与可刷新的实时看板

## 核心价值

- **查询效率提升**：围绕高频数据问答与分析任务进行工程化封装，实现稳定、快速的查询响应与流式结果返回。
- **端到端自动执行**：从 SQL 生成、只读查询、数据落盘，到 Python 分析、图表生成与报告输出，形成完整任务闭环。
- **企业级分析协同**：支持知识库、技能、MCP 工具与工作区文件协同，使单次问答能够扩展为可复用的分析流程。
- **安全可控**：在数据库访问链路中内置 SQL 安全锁与只读约束，降低误操作风险，满足生产环境使用要求。

## 目录概览

- `packages/contracts`：版本化协议契约（命令/事件 envelope、RequestContext）
- `packages/runtime`：共享 DataAgentRuntime（Pi AgentHarness、元数据、会话、知识、看板、MCP 监管）
- `packages/electron-host`：Electron 主进程与 IPC 适配器
- `packages/mcp-mysql` / `packages/mcp-pg` / `apps/server`：MCP 参考服务器与 Fastify Web Host
- `frontend/`：Vite + React 渲染层与 electron-builder 打包配置
- `packages/electron-host/preload.cjs`：渲染层版本化运行时桥
- `scripts/`：发行构建、打包、冒烟与 A–K 门禁脚本
- `tests/contract-fixtures/`：语言无关的行为契约 fixtures（Gate A）
- `docs/`：架构决策、组件设计与 A–K 门禁报告

## 环境要求

- Node.js `20+`
- npm `10+`
- Windows（桌面安装包构建当前面向 Windows；Web 开发不限）

## Clone 后安装

```bash
npm install
npm run build
```

## 运行

### Web Host（开发）

```bash
node apps/server/dist/index.js
```

### Electron 桌面端（开发）

```bash
node scripts/build-distribution.mjs   # 生成 frontend/electron-host/*.cjs（构建产物，不入库）
cd frontend
npx electron electron-host/main.cjs
```

### 桌面端打包

```bash
# 1. Python 运行时：基于 uv 管理的独立 CPython（可拷到任意机器），不能用 venv（pyvenv.cfg 绑定本机 Python）
node scripts/prepare-python-runtime-source.mjs              # → .tmp/python-runtime-source
node scripts/build-python-runtime.mjs .tmp/python-runtime-source dist/python-runtime
# 2. 应用构建与打包（只复制主进程需要的模块，better-sqlite3 取 Electron 版预编译包）
node scripts/build-distribution.mjs
node scripts/package-electron-manual.mjs
# 产物：frontend/release-manual/win-unpacked/ 与 Data Agent Setup.exe
```

### 测试与门禁

```bash
npm test                                # 全部 TS 套件
python -m pytest tests                  # 契约 fixtures（如保留 Python 环境）
node scripts/run-clean-env-gates.mjs    # Gate C 干净环境全链路
node scripts/measure-budgets.mjs        # Gate K 预算测量
```

## 构建产物

- `frontend/release*/win-unpacked/`：未打包 Electron 应用（app.asar + python-runtime pack）
- `frontend/release*/Data Agent Setup.exe`：NSIS 安装包
- `docs/gate-metrics.json`：组件体积与启动延迟基线

## 架构说明

- 统一运行时：Electron IPC 与 Web HTTP 复用同一 `DataAgentRuntime` 命令面与契约 schema
- 版本化协议：所有命令/事件使用 `protocolVersion` envelope
- MCP 优先：所有数据库查询/导出经 MCP 服务器，应用不直连业务库
- 历史决策见 `docs/pure_typescript_pi_refactor_plan.md` 与 `docs/adr/`
