# yourdb 设计规范

整个项目（工作台、登录页、落地页、桌面端）只有一套视觉语言，以工作台为准。Token 定义在 `frontend/src/styles/theme.css`，本文说明怎么用。和本文冲突的写法，以本文为准改代码。

## 气质

安静、温暖、可信的工具。读者是不写 SQL 的业务人员：界面要像纸面上的一张报表，不像终端。

- 暖石色（stone）中性色，一种品牌橙，不用冷灰（gray / slate），不用第二种强调色。
- 圆角、发丝线、白色面板浮在米灰底上；不用粗黑边框和直角。
- SQL 是品牌的口吻，只做点缀：`-- 注释` 式小标题、等宽序号、关键字标签。正文和标题不用等宽体。

## 颜色

组件里只写 token 工具类（`text-body`、`bg-success-soft`）或 `var(--token)`，不写裸色值。ESLint 会拦截 `src/` 里的十六进制色值；第三方品牌色（微信、飞书）逐行注明例外。

| 用途 | Token | 值 |
|---|---|---|
| 标题、正文强调 | `foreground` | `#1c1917` |
| 次强调文字 | `body-strong` | `#44403c` |
| 正文 | `body` | `#57534e` |
| 说明、标签 | `muted-foreground` | `#78716c` |
| 占位、装饰、禁用 | `faint` | `#a8a29e` |
| 发丝线 | `border` | `#ecebe8` |
| 输入框边、悬停边 | `input` / `border-strong` | `#e2e0dc` / `#d6d3d1` |
| 页面底（工作台外框） | `--frame-backdrop` | `#ebeae7` |
| 面板 | `background` / `card` | `#ffffff` |
| 侧栏、表头、安静面板 | `paper` | `#fafaf9` |
| 填充、气泡 | `muted` / `--bubble-bg` | `#f5f5f4` |
| 行悬停 | `hover` | `#f2f1ef` |
| 主按钮 | `primary` / `primary-hover` | `#1c1917` / `#292524` |
| 品牌、选中、焦点环 | `brand` / `ring` | `#c2410c` |
| 品牌浅底 | `brand-soft` | `#fff7ed` |
| 深色面板上的品牌色 | `brand-bright` | `#fb923c` |
| 深色面板 | `ink-panel` / `ink-panel-foreground` | `#1c1917` / `#e7e5e4` |

状态色各有文字、浅底、边框三档：`success`（`#047857`）、`warning`（`#b45309`）、`destructive`（`#b91c1c`）、`link`（`#1d4ed8`），浅底和边框加 `-soft` / `-border` 后缀。状态色只表达状态，不做装饰。

图表配色另见 `设计原则及配色方案.md` 和 `--chart-1…5`；图表的强调系列用 `chart-1`（品牌橙），其余用中性色陪衬。

## 字体

- 系统字体栈 `--font-sans`，不加载网络字体（大陆访问不稳定，且与字标不搭）。
- 等宽 `--font-mono` 只用于代码、SQL、序号、`--` 注释式标签和文件名。
- 标题字重 650–700，负字距（`tracking-[-0.02em]`，大标题 `-0.04em`）；正文行高 1.6–1.75。

## 形状与层次

- 圆角只取刻度：`rounded-sm` 6px、`rounded-md` 8px、`rounded-lg` 10px（按钮、输入框、小块）、`rounded-xl` 14px（卡片、面板）、`rounded-full`（药丸、头像、状态点）。气泡用 `--bubble-radius`。
- 分隔用 1px 发丝线 `border-border`；悬停时边变 `border-strong`，可加一层极淡的投影 `shadow-[0_8px_24px_-18px_rgba(28,25,23,0.35)]`。
- 投影只用暖墨色 `rgba(28,25,23,…)`。

## 组件

优先用 `frontend/src/components/ui`（shadcn，base-nova）：Button、Card、Table、Badge、Dialog、Trace 等。页面私有样式表不再新增：落地页、登录页、工作台都只用 Tailwind 工具类。

反复出现的母题：

- **区块标题**：等宽小字 `01`（`text-brand`）+ `-- 标签`（`text-faint`），下接标题和导语。工作台空状态、落地页各区块都这样写。
- **用户气泡**：`bg-[var(--bubble-bg)] rounded-[var(--bubble-radius)]`，靠右。
- **深色面板**：`bg-ink-panel` + `<InkBackdrop />`（细网格加一团橙色光晕）。登录页左栏、落地页的深色段落共用。
- **示例与演示**：落地页展示产品时直接渲染工作台的真实组件（`WidgetRenderer`、`Trace`），不手绘仿制品，产品改了宣传页跟着变。

## 动效

用 `theme.css` 里的 `animate-*` token 和 `--ease-out`；进场动画 260–520ms；所有动画都带 `motion-reduce:animate-none`。

## 检查

- `npm run lint --workspace=frontend`：裸色值。
- `node scripts/visual-snapshot.mjs`：视觉回归截图，含落地页。
