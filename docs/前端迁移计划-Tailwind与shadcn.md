---
status: proposed
---

# 前端样式体系迁移计划：手写全局 CSS → Tailwind CSS v4 + shadcn/ui

本计划回答两个问题：是否迁移，以及怎样迁移才能不破坏现有页面、每一步都可以停下。

**结论：迁移，按阶段渐进完成，不做一次性重写。** 长期维护的主要负担是现在的全局样式表，不是缺少组件库。迁移的价值在于让样式跟着组件走、能随组件一起删除，并获得维护良好的交互基础组件（折叠、弹窗、下拉、键盘与无障碍）和一批 agent 界面模式。代价是大约 15–18 个 PR，迁移期间新旧两套样式并存。

## 1. 现状（已对照 `develop` 核实）

### 1.1 技术栈

- React `^19.2.0`、Vite `^7.3.1`、TypeScript `~5.9.3`、Electron `39.2.7`。
- 没有 Tailwind、PostCSS 配置或 `components.json`，也没有 Radix、Base UI、`clsx`、`tailwind-merge`。
- `lucide-react` 已经是开发依赖，但只有 2 处导入。图标主要通过 `components/icons/Typicons.tsx`（13 处导入）和 `RemixIcons.tsx`（5 处导入）两个包装层使用。
- `tsconfig.app.json` 没有 `paths` 别名（没有 `@/*`）。
- Electron 生产包通过 `file://` 加载，`vite.config.ts` 在构建时设 `base: './'`。Web Host 直接服务 `frontend/dist`。
- 落地页走单独的构建模式 `build:landing`（`--mode landing`），由 `Root.tsx` 按路由懒加载。
- 没有暗色模式。
- 测试用 vitest + jsdom + Testing Library，按角色和文本断言，不依赖类名。

### 1.2 样式规模与债务

| 文件 | 行数 | 规则块 | `@media` | `!important` | 说明 |
|---|---:|---:|---:|---:|---|
| `src/index.css` | 6858 | 1033 | 30 | 19 | 全局样式，含自有重置（第 52–75 行：`* { box-sizing; margin: 0 }`、`button, input`、`body`） |
| `components/plugins/mcp-settings.css` | 1011 | 149 | 3 | 2 | MCP 页面 |
| `components/landing/landing.css` | 648 | 183 | 4 | 0 | 落地页，作用域 `.lp`，自有变量 |
| `styles/ui.css` | 643 | 99 | 2 | 0 | #214 引入的通用基础组件（卡片、输入框、按钮、开关等） |
| `styles/workspace.css` | 367 | 61 | 2 | 0 | 设置、渠道、Skills 页面 |
| `styles/chat-trace.css` | 273 | 45 | 1 | 0 | #215 的回答过程折叠 |
| `App.css` | 42 | 11 | 1 | 0 | 基本是 Vite 模板残留 |

- `index.css` 里有 **86 个顶层选择器被重复定义**（`:root` 5 次，`.chat-panel-shell` 4 次，`.sidebar`、`.tool-panel`、`.markdown-content code` 等各 3 次）。这是文件里反复“追加覆盖”留下的分层。
- `index.css` 定义了 419 个类名，其中**约 140 个在代码里找不到引用**（例如 `tool-card*`、`workspace-panel`、`upload-zone`、`file-card`、`json-*`；#215 之后 `agent-reasoning-*` 和 `agent-hint-list` 也失去了引用）。这是粗略统计，动态拼接的类名可能被误判，删除前要逐个确认。
- **21 处 `!important` 的分类**（`index.css` 19 处，`mcp-settings.css` 2 处）：
  - **有意保留（9 处）：**
    - 拖拽时的全局光标和禁止选中（`index.css` 第 806–807 行、第 4595–4596 行）；
    - 减少动态效果时关闭动画（第 2399 行，以及 `mcp-settings.css` 第 1008–1009 行）；
    - 窄屏下压过 JS 内联写入的预览窗位置（第 4989–4990 行，覆盖 `GlobalPreviewModal` 的 `style={{ left, top }}`）。

    这些规则本来就要压过一切。
  - **应清除（12 处）：** 窄屏布局里的 11 处（第 5119–5230 行，大多是当年为压过已删除的内联样式而加），以及 `.close-btn:hover` 的 1 处（第 6212 行）。
- 内联样式剩余：`WidgetRenderer.tsx` 37 处，`ChatArea`、`PluginsPanel`、`GlobalPreviewModal`、`ChartSpecWidget` 各 3 处。

### 1.3 与 Tailwind 的直接冲突（迁移的第一个坑）

- **不起作用的 Tailwind 类名会突然生效。** `ChatArea` 的消息列表写着 `flex flex-col gap-6 p-6`；`AgentTurn`（#215）的 agent 图标写着 `flex-shrink-0 flex items-center justify-center`，结果区写着 `prose prose-sm max-w-none`（这两处是从原 `ChatArea` 原样搬过去的）。今天这些类没有任何定义；一旦加载 Tailwind 工具类，前两组会立刻生效，聊天布局会变（`p-6` 会加 24px 内边距）。`prose` 需要排版插件，不会生效。
- **同名类：** `sr-only`（1 处定义）、`animate-spin`（旧版 0.8s，Tailwind 为 1s；6 个文件使用）在两边都有定义。
- 旧 CSS 用到了 `active`、`scrollable-area` 这类通用名，Tailwind 没有同名工具类，不冲突。

## 2. 外部依据（2026-11-01 读取的官方文档）

- **shadcn 必须用 Tailwind：** “Components are styled using Tailwind CSS. You need to install Tailwind CSS in your project.” 文档按 Tailwind v4 + React 19 编写。
- **shadcn 的 Vite 安装步骤会清空样式表：** 原文是 “Replace everything in `src/index.css` with the following: `@import "tailwindcss";`”。**不能照做。**
- **Tailwind v4 可以不带全局重置（Preflight）。** `@import "tailwindcss"` 默认把 Preflight 放进 `base` 层；官方写法是分开导入，并省略 `preflight.css`：
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/utilities.css" layer(utilities);
  ```
  Preflight 会去掉所有外边距、让标题不再加粗放大、清除列表样式、把 `img/svg` 设为 `display: block`。这些都会影响现有页面。
- **浏览器要求：** “Tailwind CSS v4.0 is designed for Safari 16.4+, Chrome 111+, and Firefox 128+.” Electron 39 内置的 Chromium 远高于 111；Web Host 的用户需要使用较新的浏览器。
- **组件是复制进项目的：** “There is no package to install… the code is yours.” 再次运行 CLI 会覆盖已有文件（`add --overwrite`），只有 `add --diff` 可以对比，没有 `update` 命令。复制进来的组件仍然由我们维护。
- **基础库：** 新项目默认 Base UI，官方原文为 “Starting something new? We recommend Base UI.”；Radix “is not being deprecated”；React Aria 也是一等选项。基础库在 `init` 时确定，之后不能切换（只能删除重装）。
- **初始化时就固定、之后不能改的选项：** `style`、`tailwind.baseColor`（可选 neutral / stone / zinc / mauve / olive / mist / taupe）、`tailwind.cssVariables`。
- **主题：** CSS 变量放在 `:root`（暗色放 `.dark`），通过 `@theme inline` 映射成工具类，例如 `--color-primary: var(--primary)`。可选的语义变量包括 `background`、`foreground`、`card`、`primary`、`secondary`、`muted`、`accent`、`destructive`、`border`、`input`、`ring`、`chart-1..5`、`sidebar*`、`radius`。
- **Trace 不依赖 AI SDK：** 它由 `Trace`、`TraceLine`（状态为 `running | error | pending`）、`TraceIcon`、`TraceTitle`、`TraceDescription`、`TraceCollapsible*` 组成，原文 “Trace does not read tool parts.” AI Elements 的 21 个模式（Chain of Thought、Tool、Confirmation、Plan、Queue、Sources、Context、Subagent、Code Block 等）的示例都按 AI SDK 的消息格式写，我们需要自己做一层转换。
- **前缀不一致：** shadcn 文档示例用 `tw-`，Tailwind v4 的前缀语法是 `tw:`，用法不一致。本计划不使用前缀（理由见 D6）。
- **Trace、Code Block 和 AI Elements 都提供 Base UI 版本：** 2026-10 的 changelog 原文：Trace 和 Code Block “are available for Base UI, React Aria and Radix across all eight styles”，安装命令是 `shadcn add trace code-block`。AI Elements 现在由 shadcn 维护，旧的 AI SDK Elements（elements.ai-sdk.dev）将被废弃（“we are going to deprecate”）；各模式页面都提供三种基础库版本（例如 `/docs/ai-elements/base/chain-of-thought`）。第三方社区组件库则大多基于 Radix 和 `asChild` 编写。
- **级联层里 `!important` 的顺序是反过来的（CSS 规范）：** 普通声明是后声明的层胜出，`!important` 声明则是先声明的层胜出，而且分层的 `!important` 胜过不分层的 `!important`。所以 `legacy` 层里的 `!important` 会压过 `utilities` 层的普通声明，也会压过 `utilities` 层的 `!important`。

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 通过 `@tailwindcss/vite` 引入 Tailwind v4；在第 4 阶段之前**不引入 Preflight** | 现有页面依赖 `index.css` 自己的重置和浏览器默认样式；先引入 Preflight 会造成全站视觉回退 |
| D2 | 用级联层控制优先级，层的顺序为 `theme, base, legacy, components, utilities`，旧 CSS 全部放进 `legacy` 层；**所有 CSS 都必须归入某一层，不留不分层的规则**。旧 CSS 中的 `!important` 只保留 9 处有意为之的（见 1.2），其余在第 0 阶段清除 | 不在任何层里的 CSS 会压过所有分层的 CSS。旧 CSS 不进层的话，Tailwind 工具类永远赢不了它。放进 `legacy` 层后，工具类和 shadcn 组件样式会压过旧样式，迁移时可以逐步替换。`!important` 在层间顺序相反（见第 2 节），保留的 9 处正好需要“永远赢” |
| D3 | shadcn 基础库选 **Base UI**，**以第 0 阶段原型验收为准**：用 `shadcn view` 逐个确认第 2 阶段清单里的组件和计划用到的 AI Elements 模式都有 Base UI 版本，**只要缺一个就改选 Radix** | 项目目前没有任何基础库，属于“新开始”；Base UI 是官方默认和推荐，Trace、Code Block、AI Elements 都有 Base UI 版本（见第 2 节）。代价是第三方社区组件多按 Radix 和 `asChild` 写，引入时要改写成 `render` 写法。这个选择不可逆，所以要先验收，并给出明确的回退条件 |
| D4 | `baseColor` 选 **stone**，`cssVariables: true` | 和现在的暖灰配色一致；用 CSS 变量才能映射到品牌色。这两个选项也不可逆 |
| D5 | 变量映射：`--primary` 用墨色 `#1c1917`（主按钮就是墨色），`--ring` 用品牌橙 `#c2410c`，另加 `--brand` 和 `--brand-soft` 表示品牌橙。shadcn 的 `--accent` 保持它原本的含义：悬停时的浅底色 | shadcn 的 `accent` 是浅色悬停面，不是品牌强调色；直接把橙色映射过去，会让所有菜单的悬停状态变成橙色 |
| D6 | **不用前缀** | 冲突已经清点过（见 1.3），数量很少，可以在第 1 阶段处理掉。用前缀会让每个组件多写 `tw:`，和 shadcn 生成的代码也对不上（shadcn 示例用 `tw-`，Tailwind 语法是 `tw:`） |
| D7 | 新代码用 `lucide-react` 图标，这也是 shadcn 的默认图标库，且已安装。`Typicons` 和 `RemixIcons` 两个包装层在各页面迁移时一并替换，最后删除 | 两个包装层导出的名字本来就按 lucide 命名（如 `Loader2`、`ChevronRight`），替换基本是改 import |
| D8 | 加 `@/*` 路径别名（`tsconfig.app.json` 的 `paths`，加上 Vite 的 `resolve.alias`）；`vite.config.ts` 是 ESM，用 `fileURLToPath(new URL('./src', import.meta.url))`，不用 `__dirname` | shadcn CLI 靠别名决定文件放哪、怎么改写 import |
| D9 | **不执行** `shadcn init`，手写 `components.json` 和主题 CSS，之后只用 `shadcn add` 添加组件 | `init` 会改写全局 CSS；手写可以完全掌控写入内容。也可以在临时目录里运行一次 `init`，把生成的内容拷过来 |
| D10 | 回答过程折叠改用 Trace + Collapsible 实现；`utils/agent-turns.ts` 的分组、结果切分和计时逻辑原样保留 | 只换界面层，逻辑和测试不动 |
| D11 | Markdown 回答用 `@tailwindcss/typography` 的 `prose` 风格，用变量调成我们的配色；表格、代码块单独定制 | 现有 `.markdown-content` 规则散落在多处（`code` 和 `pre code` 各定义 3 次），收拢后更好维护 |
| D12 | 落地页最后处理，可以不迁 | 它的作用域独立（`.lp`），有自己的构建模式和视觉语言，迁移收益最低 |
| D13 | 图表（ECharts 画布）和看板 iframe 不受影响；`WidgetRenderer` 的 37 处内联样式在第 3 阶段改成工具类 | 画布和 iframe 内部不受宿主页面 CSS 影响 |
| D14 | **前端新增的所有依赖都放进 `frontend/package.json` 的 `devDependencies`**；`shadcn add` 自动写进 `dependencies` 的包要手动移过去 | `frontend/package.json` 的 `dependencies` 只有主进程要用的 `@modelcontextprotocol/sdk` 和 `mysql2`，React、ECharts、lucide 都在 `devDependencies`。electron-builder 会把 `dependencies` 打进安装包；渲染进程的代码已经被 Vite 打进 `dist/`，再放进 `dependencies` 会在安装包里重复一份 |

## 4. 目标状态（完成的定义）

- `src/index.css` 只剩 Tailwind 的导入、主题变量和极少量全局基础样式（字体、滚动条），控制在 150 行左右。`legacy` 层被删空，`styles/ui.css`、`workspace.css`、`chat-trace.css`、`mcp-settings.css` 全部删除。
- 所有界面组件来自 `src/components/ui/*`（shadcn 复制件）或用工具类组合；再也没有页面级的全局类名样式。
- 配色、圆角、动效时长只在一处定义（CSS 变量），改主题只改变量。
- 两个图标包装层删除，统一用 `lucide-react`。
- 启用 Preflight，视觉与迁移前一致，只有有意为之的改动。

## 5. 分阶段计划

每个阶段由若干独立 PR 组成，每个 PR 都能单独回滚，任何时候都可以停下。每个 PR 都要通过第 6 节的质量门槛。

### 第 0 阶段：护栏与清理（4 个 PR，加 1 个不合并的原型；不引入运行时依赖）

1. **固定测试数据（PR 0.1）。** 截图对比需要每次都一样的数据，不能依赖实时账号和模型输出：
   - 准备一个预置数据目录（例如 `evaluations/visual/fixture-data/`），里面放好固定的测试账号、几个固定会话（含表格答案、多步回答过程、澄清卡片），以及数据库和渠道的配置；
   - 写一个脚本，用这个目录启动 Web Host：`scripts/start-web-host.mjs` 已经支持 `DATA_AGENT_DATA_DIR` 和 `DATA_AGENT_KNOWLEDGE_DIR` 两个环境变量，所以每次运行前把预置目录复制到临时位置再指向它，避免测试改动污染预置数据。不连真实数据库和模型；
   - 会话里只放已完成的回答，不触发任何模型调用。
2. **视觉回归脚本（PR 0.2）。** 新增 `scripts/visual-snapshot.mjs`，沿用 `scripts/smoke-charts-browser.mjs` 通过 Chrome DevTools 协议驱动浏览器的方式：
   - 用固定数据启动 Web Host，登录测试账号，访问固定的页面矩阵：落地页、登录、聊天空状态、聊天含表格、回答过程折叠与展开、设置四个分区、MCP 两个标签、Skills、知识库、工具面板。
   - 每个页面截 1440×900 和 390×844 两个尺寸。
   - 用 `pixelmatch`（开发依赖；`pngjs` 已经间接存在）和基线图比较，超过阈值就失败。
   - **防止误报：**
     - 截图前通过 `Emulation.setEmulatedMedia` 设置 `prefers-reduced-motion: reduce`；
     - 注入只在截图时生效的样式：`*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`；
     - 等待 `document.fonts.ready` 和网络空闲；
     - 冻结时钟：在页面加载前固定 `Date.now`。这样"已处理 N 秒"、授权名单的时间、二维码和绑定码倒计时每次都一样。
   - 页面按顺序截取，复用同一个浏览器，控制内存（开发机只有 4 GB）。

   先在本地运行；有了固定数据之后，可以再加一个 CI 任务。
3. **删除死样式（PR 0.3）。**
   - 逐个确认那约 140 个无引用的类名，连同它们的规则一起删除；
   - 把 86 个重复定义的选择器合并成一处；
   - 清除 1.2 列出的 12 处应清除的 `!important`。如果它们压过的内联样式还在，要同时把内联样式移进 CSS；
   - 保留的 9 处在规则旁加注释说明原因。

   视觉差异应为 0。
4. **消除冲突（PR 0.4）。** 去掉 `ChatArea` 和 `AgentTurn` 里不起作用的 `flex flex-col gap-6 p-6`、`flex-shrink-0 flex items-center justify-center`、`prose prose-sm max-w-none`。旧 CSS 里的 `.sr-only` 和 `.animate-spin` 先改名为 `legacy-sr-only`、`legacy-animate-spin`，第 4 阶段再换成 Tailwind 的同名工具类。
5. **原型验证（在临时分支上做，不合并）。** 用来回答第 1、2 阶段的未知问题，出一页结论附在 PR 0.4 里：
   - Tailwind 的 Vite 插件能否处理带 `layer(legacy)` 的相对路径 `@import`，旧样式进层后视觉是否不变；
   - 保留的 9 处 `!important` 在层内行为符合预期；
   - Electron 打包（`file://` 加 `base: './'`）后字体和资源路径正常，以及构建产物体积变化；
   - **D3 的验收：** 用 `shadcn view` 确认第 2 阶段清单里每个组件、计划用到的 AI Elements 模式都有 Base UI 版本，据此定下基础库；
   - `shadcn add` 实际写入了哪些依赖，验证 D14 的处理方法。

**本阶段的产出：** `index.css` 预计缩小 20–30%，有了可重复的回归检测，第 1 阶段的未知问题有了答案。即使最终不迁移，这一阶段的收益也成立。

### 第 1 阶段：Tailwind 地基（1 个 PR，视觉零变化）

- 依赖（全部放 `devDependencies`，见 D14）：`tailwindcss`、`@tailwindcss/vite`、`clsx`、`tailwind-merge`、`tw-animate-css`。
- `vite.config.ts` 加 `tailwindcss()` 插件和 `@` 别名；`tsconfig.app.json` 加 `paths`。
- 新入口样式 `src/styles/app.css`。所有导入都归入某一层，不留不分层的规则：
  ```css
  @layer theme, base, legacy, components, utilities;

  @import "tailwindcss/theme.css" layer(theme);
  @import "./theme.css" layer(theme); /* :root 变量与 @theme inline 映射 */

  @import "../index.css" layer(legacy);
  @import "./ui.css" layer(legacy);
  @import "./workspace.css" layer(legacy);
  @import "./chat-trace.css" layer(legacy);
  @import "../components/plugins/mcp-settings.css" layer(legacy);

  @import "tailwindcss/utilities.css" layer(utilities);
  @import "tw-animate-css" layer(utilities);
  ```
  `main.tsx` 改成只导入 `app.css`。`McpSettings.tsx` 里对 `mcp-settings.css` 的导入删掉，统一由这里放进 `legacy` 层。
- `theme.css`：按 D4、D5 把 shadcn 的语义变量映射到现有值（墨色 `#1c1917`、正文 `#57534e`、次要 `#78716c`、细线 `#ecebe8`、品牌橙 `#c2410c`、圆角 10 / 14px、`--ease-out`），旧的 `--ui-*` 和 `--hairline` 改为引用新变量，保证只有一处来源。
- `src/lib/utils.ts`：`cn()`。
- 原型（第 0 阶段第 5 步）已经回答的问题在这里落地；如果原型发现阻碍，就停在第 0 阶段。

**退出条件：** 视觉回归差异为 0，CI 全绿，Electron 打包后可以正常运行。

### 第 2 阶段：shadcn 组件库（1–2 个 PR）

- 手写 `components.json`：基础库按第 0 阶段原型的验收结果填写（默认 Base UI），`baseColor: stone`，`cssVariables: true`，别名 `@/components`、`@/components/ui`、`@/lib/utils`，图标库 lucide。
- 第一批组件（`shadcn add`）：`button`、`input`、`label`、`textarea`、`select`、`switch`、`toggle-group`、`badge`、`card`、`alert`、`table`、`collapsible`、`trace`、`code-block`、`tooltip`、`dialog`、`sheet`、`dropdown-menu`、`sonner`。
- `shadcn add` 之后检查 `frontend/package.json`：把它新增到 `dependencies` 的包（基础库、`class-variance-authority`、`sonner` 等）移到 `devDependencies`，并检查根目录的 `package-lock.json` 是否同步。
- 加一个仅开发环境可见的组件预览页（例如 `/app/__kit`），把组件和品牌主题放在一起看，作为主题调校和视觉回归的参照。
- 约定：复制进来的组件**只通过变量和 `className` 定制，尽量不改源码**；确实需要改时，在文件顶部注释说明改了什么，方便以后用 `add --diff` 对比上游。

### 第 3 阶段：逐页迁移（10–12 个 PR，每个区域一个）

每个 PR：
- 把这个区域的组件改用 `ui/*` 加工具类；
- **删除这个区域在 legacy 层里的全部规则**；
- 换掉这个区域用到的 Typicons / Remix 图标；
- 视觉回归只允许出现有意的差异，并在 PR 里贴前后对比截图。

排序原则：**先清老债务，最后收口新模块**。`index.css` 和 `mcp-settings.css` 是历史债务集中的地方，越早迁收益越大；#214、#215 新写的 `ui.css`、`workspace.css`、`chat-trace.css` 结构干净、没有重复定义、没有 `!important`，放在 legacy 层里不会造成问题，放到最后收口。第一个区域选登录页当试点：它结构独立、页面小，适合验证主题和组件的用法。

| 顺序 | 区域 | 主要组件 | 可删除的旧样式 |
|---:|---|---|---|
| 3.1 | 登录（试点） | Input、Button、Label | `index.css` 的 `auth-*` |
| 3.2 | MCP | Tabs、Card、Switch、Input、Checkbox | `mcp-settings.css`（1011 行） |
| 3.3 | 预览、知识库、编辑器弹窗 | Dialog、Sheet、Code Block | `index.css` 的 Global file preview、Knowledge Panel、Editor Modal 部分；第 4989–4990 行的两处 `!important`（预览窗位置改由组件按窗口宽度计算） |
| 3.4 | 工具面板 | Sheet、Trace、Code Block | Tool Panel 的两大段（约第 1794–2240 行和第 5607 行之后） |
| 3.5 | 侧边栏与树 | Collapsible、Button、Tooltip、Sonner（替换侧边栏 Toast） | Sidebar、SidebarTree、Toast 部分；拖拽相关的 4 处 `!important`（改为拖拽时在根元素上加工具类） |
| 3.6 | 聊天区与 Markdown 回答 | Button、Textarea、Card、ToggleGroup；typography 插件加表格、代码块定制（D11） | `index.css` 的 Chat、Message、Chat Input、clarification 部分，以及 `.markdown-content*` 的所有重复定义 |
| 3.7 | 图表与看板挂件 | 工具类替换 37 处内联样式 | — |
| 3.8 | 设置、Skills 与回答过程收口 | Card、Input、Select、Switch、ToggleGroup、Alert、Table、Badge、Trace、Collapsible（D10） | `styles/ui.css`、`workspace.css`、`chat-trace.css` 全部删除；Trace 版的回答过程要保留现有交互：运行时的流光文字（`TraceTitle` 自带）、折叠的高度过渡、减少动态效果时关闭动画 |

AI Elements 模式（Confirmation、Plan、Context、Sources 等）在对应功能需要时再引入，并写一层“runtime 事件 → 组件属性”的转换，放在 `utils/` 并配单测，这一层不依赖 AI SDK。

### 第 4 阶段：收尾（1–2 个 PR）

- 删除 legacy 层与 `index.css` 的剩余内容，只保留第 4 节描述的入口样式。
- 引入 Preflight（加回 `@import "tailwindcss/preflight.css" layer(base);`），跑全量视觉回归，修复因此产生的差异（主要是标题、列表、图片默认样式）。
- 删除 `Typicons.tsx`、`RemixIcons.tsx`。
- 把 `legacy-sr-only`、`legacy-animate-spin` 换成 Tailwind 的 `sr-only`、`animate-spin`。减少动态效果的处理改用 Tailwind 的 `motion-reduce:` 变体。至此 legacy 层清空，保留的 9 处 `!important` 也随之消失。

### 第 5 阶段（可选）：落地页

视觉语言独立，可以长期保留 `.lp` 作用域样式。如果要统一，单独评估。

## 6. 质量门槛（每个 PR）

- `tsc -p tsconfig.app.json --noEmit`、frontend `vitest run`、eslint 全部通过，CI 全绿（按约定以 CI 为准）。
- 视觉回归：第 0、1 阶段和第 3 阶段的“纯替换”部分要求零差异；有意的设计变化在 PR 中贴前后截图说明。
- 涉及交互的组件替换（Dialog、Select、Collapsible、Switch），补上或保留按角色断言的测试：键盘可以操作，`aria-*` 正确。
- 每个第 3 阶段的 PR 都要真正删掉对应的旧 CSS，并在 PR 描述里写明 `index.css` 减少了多少行，作为进度指标。
- **依赖检查：** `frontend/package.json` 的 `dependencies` 只能是主进程要用的包；新增的前端依赖一律进 `devDependencies`（D14）。
- **不新增 `!important`，也不新增不分层的 CSS。** 唯一例外是第 0 阶段截图脚本注入的、只在截图时生效的样式。

## 7. 风险与对策

| 风险 | 可能性 | 影响 | 对策 |
|---|---|---|---|
| 不起作用的 Tailwind 类名在接入后突然生效 | 已确认存在 | 聊天布局变化 | 第 0 阶段 PR 0.4 先清除；第 1 阶段的视觉回归兜底 |
| `legacy` 层的 `!important` 压过工具类，包括工具类的 `!important`（层间顺序相反） | 已确认（规范如此） | 对应元素上的工具类不生效 | 第 0 阶段清除 12 处；保留的 9 处都在拖拽、减少动态效果、窄屏预览位置这类不会用工具类覆盖的地方，并加注释；随所在区域迁移（3.3、3.5）和第 4 阶段逐步消失 |
| 有遗漏的不分层 CSS（例如第三方样式表）压过所有层 | 中 | 工具类和组件样式不生效 | `app.css` 里每个导入都指定层；质量门槛禁止新增不分层的 CSS |
| shadcn 的 `init` 或 `add --overwrite` 覆盖已改动的文件 | 中 | 本地改动丢失 | 不运行 `init`；`add` 不加 `--overwrite`；组件改动加注释，用 `--diff` 对比上游 |
| `shadcn add` 把前端依赖写进 `dependencies`，在 Electron 安装包里重复一份 | 高（CLI 默认行为） | 安装包变大 | D14；第 2 阶段步骤和质量门槛都要检查 |
| 基础库、`style`、`baseColor` 选错，之后无法更改 | 低 | 只能重装全部组件 | 第 0 阶段原型用 `shadcn view` 验收；缺任何一个 Base UI 版本就改选 Radix |
| 第三方社区组件大多按 Radix 和 `asChild` 写 | 中 | 选 Base UI 后，引入第三方组件要改写成 `render` 写法 | 优先用 shadcn 官方组件和 AI Elements（都有 Base UI 版本）；确实要用第三方组件时，在 PR 里评估改写成本 |
| 截图对比因为动画、字体加载、时间或实时数据而误报 | 高 | 回归检测不可信，最后被忽略 | 第 0 阶段：固定测试数据、减少动态效果加禁用动画、等待字体加载、冻结时钟 |
| 迁移中途停滞，两套样式长期并存 | 中 | 维护负担暂时增加 | 每个 PR 必须删除旧 CSS；按区域推进，而不是按组件类型推进；第 0 阶段即使单独完成也有收益 |
| Web Host 用户的浏览器版本过旧 | 低 | 样式失效 | 在登录页检测 `@property` 或 `color-mix` 是否可用，不支持时提示升级浏览器 |
| 本地开发机内存不足（4 GB，已多次出现内存不够） | 已发生 | 本地无法构建或截图 | 视觉回归脚本按页面串行执行、复用同一个浏览器；构建以 CI 为准 |
| 复制进来的组件没有上游更新渠道 | 确定 | 修复要手动跟进 | 定期用 `shadcn add <name> --diff` 对比上游；组件尽量不改源码 |

## 8. 工作量与节奏

- 第 0 阶段：4 个 PR 加 1 个原型。第 1 阶段：1 个。第 2 阶段：1–2 个。第 3 阶段：8 个以上（大的区域可以拆分）。第 4 阶段：1–2 个。合计约 15–20 个 PR。
- 第 0、1 阶段先做完再评估：如果原型发现层叠或打包有阻碍，可以在第 1 阶段之后停下，已完成的清理和回归脚本仍然有价值。
- 第 3 阶段可以和功能开发交错进行：哪个区域要加新功能，就先迁移那个区域。

## 9. 不在本计划内

- 暗色模式（迁移完成后只需要补 `.dark` 变量，可以单独立项）。
- 引入 Vercel AI SDK。我们的 runtime 有自己的事件和快照格式，组件通过转换层接入。
- 落地页的重新设计。

## 10. 已确认的开工前问题

| 问题 | 结论 |
|---|---|
| 基础库用 Base UI 还是 Radix | 默认 Base UI，以第 0 阶段原型的 `shadcn view` 验收为准；需要的组件缺任何一个 Base UI 版本，就改选 Radix（D3） |
| 截图对比的测试数据 | 准备固定测试数据，配合冻结时钟（第 0 阶段 PR 0.1、PR 0.2） |
| 第 0 阶段是否单独做 | 是。完成后评估原型结论，再决定是否进入第 1 阶段 |

## 11. 修订记录

- 2026-11-01 初稿。
- 2026-11-01 按审阅意见（`docs/前端迁移计划-Tailwind与shadcn-审阅意见.md`）修订：
  - **采纳：**
    - `app.css` 的所有导入都归入层（2.3）；
    - 前端依赖统一放 `devDependencies`（2.4，新增 D14）；
    - 第 3 阶段改为先清老债务、以登录页为试点（2.5）；
    - 截图防误报，并补上冻结时钟和固定测试数据（2.6）。
  - **部分采纳 2.1：** 层间 `!important` 顺序相反的分析正确，已补进第 2 节和 D2。但不是 21 处全部清零：其中 9 处（拖拽、减少动态效果、窄屏预览位置）本来就要压过一切，保留并注释；只清除 12 处。
  - **不采纳 2.2 的论据，但加了验收条件：** 审阅认为 Trace、Code Block 不是 shadcn 组件、AI Elements 只基于 Radix。这描述的是将被废弃的旧版 AI SDK Elements；按 2026-10 官方文档，三者都提供 Base UI 版本（见第 2 节）。审阅提出的第三方社区组件偏向 Radix 的问题成立，已列入风险表。D3 改为以原型验收为准，并写明回退到 Radix 的条件。
