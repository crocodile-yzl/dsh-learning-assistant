# dsh-learning-assistant · 学习助手

> 模型照常回答，插件补它没解释的**专业术语**：自动记进记忆、按对话过滤展示，右侧栏知识树 + 正文高亮 + 一句话解释与学习路径。越用越懂你已经会了什么。

## 它做了什么

1. **判断**：Host 半往系统提示里注入一段规则——结合「你的水平档位」「解释倾向严格度」「记忆里你已经见过的词」，判断本次回答里哪些词值得解释。没有需要解释的词就不调用。
2. **记录**：模型调用 `explain_terms` 工具，Host 把词条写入 `$DSH_HOME/dsh-learning-assistant/terms.json`。重复出现的词会累加 `count`（这是"你可能已经学会了"的证据）。
3. **呈现**：**对话标题栏常驻一个「术语 N」按钮**（N = 全局词条数），点它打开右侧栏标签页。面板默认**只列本对话涉及的词**（记忆本身是全局的，跨对话不会重复解释），顶部可切「本对话 / 全部」。面板有「词条 / 知识树」两个视图：
   - **词条**：每个词一张卡片——解释、缩进学习路径、隶属/延伸跳转、维基/Google/Bing 外链。可在当前范围内搜索术语名称或解释；
   - **知识树**：按「隶属 → 延伸」组织的层级视图，节点显示分类与「延伸 N」，点击任一节点回到词条视图并定位。
4. **正文高亮**：已在侧栏有词条的术语，在对话正文里自动标记（淡蓝底 + 虚线下划线）。纯视觉层——没有悬浮气泡；**点击标记**会打开右侧栏并**自动滚动到该词卡片**（卡片同时脉冲两次）。
5. **自动呈现**：新词入库时，右侧栏会**自己展开**并切到「术语」标签（首次加载不会抢视图，只有词条集合真的增长时才开）。
6. **反向定位**：**双击侧栏卡片**，正文里该词的**所有出现位置一起闪烁三次**（琥珀色），若不在视口内先把第一处滚到中间。
6. **自适应**：用户连续追问同一个概念时，模型会把 `strictnessAdjust` 设为 +10，以后更倾向于解释。

## 架构

```
lib/index.js         Host 半（ESM）
  ├─ explain_terms 工具       ctx.tools.register(defineTool(...))
  ├─ 系统提示段落             ctx.systemPrompt.section(...)（动态读取记忆）
  ├─ HTTP 路由 /learning-assistant/*  ctx.webServer.register({kind:'prefix'})
  └─ 记忆文件                 $DSH_HOME/dsh-learning-assistant/terms.json

lib/client.js        Client 半（构建产物，window.__ModuleLoader__ 格式）
  ├─ 常驻入口        ctx.slots.register('conversation.session.header.actions') → 「术语 N」按钮
  ├─ 标签类型        ctx.sidebarRightTabs.register({ id, kind, title })
  ├─ 标签主体        ctx.slots.register({ name: 'sidebar.right.pane.tab', key })
  ├─ 打开            ctx.sidebarRight.openTab(kind)（自动展开右栏）
  └─ 轮询 /learning-assistant/state（5s + 窗口聚焦，在 apply 里跑）

lib/core/guide.js    两端共享的纯逻辑（归一化 / 合并 / 外链模板）
lib/core/highlight.js  正文高亮：CSS Custom Highlight + 点击命中（无悬浮气泡）
lib/core/shell.js    Client 源码（React.createElement，无 JSX）
tools/build-client.mjs   把 core/*.js 内联进 lib/client.template.js → lib/client.js
tools/selfcheck.mjs      两端功能自检（33 项）
tools/probe-page.mjs     无头浏览器：页面是否含侧栏行、控制台有无报错
tools/probe-panel.mjs    无头浏览器：点开面板并校验词条/树/外链渲染
tools/probe-autopen.mjs  无头浏览器：正文高亮 Range 数 + 新词到达是否自动开面板
tools/probe-geometry.mjs 无头浏览器：面板与对话的几何关系（不得重叠）
tools/probe-containers.mjs 无头浏览器：打印面板容器的 overflow/高度链（排查滚动问题）
tools/probe-scroll.mjs   无头浏览器：滚动区能否滚到底、表头是否被裁
tools/probe-interact.mjs 无头浏览器：点词→面板滚到卡片；双击卡片→正文闪烁
tools/probe-accuracy.mjs 无头浏览器：卡片居中偏差 + 闪烁帧是否都在视口内
```

## 装载 / 更新 / 卸载（后续复用）

包内自带 `install.sh`，把"检查 pnpm → 写依赖 → 登记 bundle → 建链接"一次做完：

```bash
./install.sh                 # 装到 web profile（幂等，已装时显示 Already up to date）
./install.sh tui             # 装到别的 profile
DSH_BIN=/path/to/dsh ./install.sh   # dsh 不在 PATH 时
```

手动等价命令：

```bash
dsh plugin --profile web add    /home/y/2026-11-13-11-29-22/dsh-learning-assistant
dsh plugin --profile web remove dsh-learning-assistant      # 卸载
```

### 装载后的检查清单

| 步骤 | 命令 / 现象 |
|---|---|
| 1. profile 是否登记 | `node -e "console.log(require('/home/y/.dsh/profiles/web/package.json').dsh.profile.bundles)"` 里应含 `dsh-learning-assistant` |
| 2. 启动（无需 `--patch`） | `dsh web --no-open --port 3080` |
| 3. 取访问地址 | `tail -n 3 <日志>`，形如 `http://127.0.0.1:3080/?token=…` |
| 4. 后端是否加载 | `curl -b <cookie> http://127.0.0.1:3080/learning-assistant/state` → 200 + JSON |
| 5. 前端是否加载 | 对话标题栏出现「术语 N」按钮 |
| 6. 端到端 | 问一个含专业缩写的问题，回答后侧栏应出现该词（标「自动补充」） |

### 更新

- **本地目录装法**（`link:` 依赖）：重跑 `./install.sh` 即可，pnpm 会重新链接，重启 dsh 生效。
- **npm 包装法**：`dsh plugin --profile web add dsh-learning-assistant@latest` 后重启。
- 面板里提示「如需升级，请卸载后重新安装」时，按上面的 remove + add 走一遍。

## 启用

```bash
dsh web --patch /绝对路径/dsh-learning-assistant/cordis.patch.yml --no-open --port 3080
```

`--patch` 后面跟路径时，会把这个 overlay 叠在 profile 之上；`cordis.patch.yml` 里只有一行：插入 `learning-assistant` 这个 Host 半。Client 半不需要单独一行——`package.json` 的 `dsh.client` 声明会让客户端模块系统自动加载 `exports["./client"]`。

也可以把这一行加进 `~/.dsh/profiles/web/cordis.patch.yml`，让它在每次启动时自动生效。

## 构建客户端

```bash
node tools/build-client.mjs          # 生成 lib/client.js
node tools/build-client.mjs --check  # CI：校验产物是否最新
```

只依赖 `react` 一个平台 seed；没有 CSS 文件、没有 JSX，因此不需要打包器。

## 自检

```bash
node tools/selfcheck.mjs          # 两端 40+ 断言，零依赖
```

`tools/probe-*.mjs` 是无头浏览器探针（滚动/几何/交互/知识树/安装弹窗），需要 `playwright-core`
可被解析——请在装有它的目录下运行（例如 dsh 的安装目录），它们不随包发布。

覆盖：bundle 注册 / 两个 slot 注册 / 卡片渲染（含树与外链 `noopener`）/ 空状态 / 工具执行 / 记忆落盘 / 外链自动补全 / 严格度自适应 / 系统提示内容 / HTTP 四个路由。

## 配置（cordis.patch.yml 的 config）

| 字段 | 含义 | 默认 |
|---|---|---|
| `level` | `beginner` / `intermediate` / `expert`，判定基准 | `intermediate` |
| `strictness` | 0–100，越高越爱解释；面板里的滑杆改的是同一个值 | `50` |
| `autoAdapt` | 预留给模型的自适应开关 | `true` |

面板里的「我的水平」「解释倾向」改动会写回记忆文件，优先级高于 config 默认值。

## HTTP 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/learning-assistant/state` | 读取词条 / 水平 / 严格度 |
| POST | `/learning-assistant/level` | `{ level }` |
| POST | `/learning-assistant/strictness` | `{ value }` |
| POST | `/learning-assistant/forget` | `{ term }` 移除一个词条 |
| POST | `/learning-assistant/clear` | 清空词条 |

## 数据模型

`terms.json` 的每个词条除 `term` / `explanation` / `tree` / `links` / `count` 外，还可能有：

| 字段 | 含义 |
|---|---|
| `parent` | 它从哪个已收录词延伸出来（知识树的上级）。缺失或指向未收录词时，该词作为根节点，并标注「隶属 X（未收录）」 |
| `related` | 同层或强相关词的名称，卡片上以 `↔` 芯片展示 |

模型在 `explain_terms` 里填写这两个字段；Host 归一化时剔除自引用与空值。树的构建（`guide.buildKnowledgeTree`）对环、缺失父级、重复挂载都做了保护，最多 9 层。

## 安装

dsh 的「设置 → 插件 → 添加插件」接受三种输入：**npm 包名**、**GitHub 仓库地址**、**本地目录路径**。
本包三种都支持，其中本地目录路径**无需发布**即可安装。

### 方式 A：插件面板 / 官方命令（推荐）

在面板里粘贴包名或路径后点「安装」，等价于：

```bash
# 本地目录（未发布时用这个）
dsh plugin --profile web add /home/y/2026-11-13-11-29-22/dsh-learning-assistant

# npm 包名（发布之后）
dsh plugin --profile web add dsh-learning-assistant

# GitHub 仓库（仓库公开之后）
dsh plugin --profile web add https://github.com/<你>/dsh-learning-assistant
```

这条命令会做三件事：把包写进 profile 的 `dependencies`、把它加进
`dsh.profile.bundles`、并让 pnpm 建立 `node_modules` 链接。**装完即生效，启动时不需要 `--patch`**。

> 前提：`pnpm` 必须在 dsh 进程的 PATH 里（插件管理器用 `pnpm add` 安装）。
> 本机已装到 `/home/y/.local/npm-global/bin/pnpm`，启动脚本会把它加进 PATH。

### 方式 B：手动软链（只调试、不走管理器）

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn /home/y/2026-11-13-11-29-22/dsh-learning-assistant ~/.dsh/profiles/web/node_modules/dsh-learning-assistant
```

此时 profile 里没有 bundle 记录，启动要显式带 patch：

```bash
dsh web --patch /home/y/2026-11-13-11-29-22/dsh-learning-assistant/cordis.patch.yml
```

### 方式 C：从 tarball 安装（离线分发）

```bash
npm pack                                                    # dsh-learning-assistant-0.2.0.tgz
cd ~/.dsh/profiles/web && pnpm add /绝对路径/dsh-learning-assistant-0.2.0.tgz
```

> dsh 从 **profile 目录**解析裸包名（`~/.dsh/profiles/web/`），不是从安装 dsh 的目录，
> 所以插件必须能被 profile 的 `node_modules` 找到。

## 启用

```bash
dsh web --patch /绝对路径/dsh-learning-assistant/cordis.patch.yml --no-open --port 3080
```

`--patch` 后面跟路径时，会把这个 overlay 叠在 profile 之上；`cordis.patch.yml` 里只有一行：插入 `learning-assistant` 这个 Host 半。Client 半不需要单独一行——`package.json` 的 `dsh.client` 声明会让客户端模块系统自动加载 `exports["./client"]`。

也可以把这一行加进 `~/.dsh/profiles/web/cordis.patch.yml`，让它在每次启动时自动生效。

## 构建客户端

```bash
node tools/build-client.mjs          # 生成 lib/client.js
node tools/build-client.mjs --check  # CI：校验产物是否最新
```

只依赖 `react` 一个平台 seed；没有 CSS 文件、没有 JSX，因此不需要打包器。

## 自检

```bash
node tools/selfcheck.mjs          # 两端 40+ 断言，零依赖
```

`tools/probe-*.mjs` 是无头浏览器探针（滚动/几何/交互/知识树/安装弹窗），需要 `playwright-core`
可被解析——请在装有它的目录下运行（例如 dsh 的安装目录），它们不随包发布。

覆盖：bundle 注册 / 两个 slot 注册 / 卡片渲染（含树与外链 `noopener`）/ 空状态 / 工具执行 / 记忆落盘 / 外链自动补全 / 严格度自适应 / 系统提示内容 / HTTP 四个路由。

## 配置（cordis.patch.yml 的 config）

| 字段 | 含义 | 默认 |
|---|---|---|
| `level` | `beginner` / `intermediate` / `expert`，判定基准 | `intermediate` |
| `strictness` | 0–100，越高越爱解释；面板里的滑杆改的是同一个值 | `50` |
| `autoAdapt` | 预留给模型的自适应开关 | `true` |

面板里的「我的水平」「解释倾向」改动会写回记忆文件，优先级高于 config 默认值。

## HTTP 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/learning-assistant/state` | 读取词条 / 水平 / 严格度 |
| POST | `/learning-assistant/level` | `{ level }` |
| POST | `/learning-assistant/strictness` | `{ value }` |
| POST | `/learning-assistant/forget` | `{ term }` 移除一个词条 |
| POST | `/learning-assistant/clear` | 清空词条 |

## 数据模型

`terms.json` 的每个词条除 `term` / `explanation` / `tree` / `links` / `count` 外，还可能有：

| 字段 | 含义 |
|---|---|
| `parent` | 它从哪个已收录词延伸出来（知识树的上级）。缺失或指向未收录词时，该词作为根节点，并标注「隶属 X（未收录）」 |
| `related` | 同层或强相关词的名称，卡片上以 `↔` 芯片展示 |

模型在 `explain_terms` 里填写这两个字段；Host 归一化时剔除自引用与空值。树的构建（`guide.buildKnowledgeTree`）对环、缺失父级、重复挂载都做了保护，最多 9 层。

## 安装

包本身是独立目录（`dsh-learning-assistant/`），不依赖 dsh 的安装位置，也不在 dsh 安装目录内。
三种装法任选其一。

### 方式 A：官方插件命令（推荐）

```bash
dsh plugin --profile web add dsh-learning-assistant        # 已发布到 npm 时
dsh plugin --profile web add /绝对路径/dsh-learning-assistant   # 本地目录
```

### 方式 B：手动软链（本机调试，最快）

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn /绝对路径/dsh-learning-assistant ~/.dsh/profiles/web/node_modules/dsh-learning-assistant
```

### 方式 C：从 tarball 安装（离线分发）

```bash
npm pack                       # 产出 dsh-learning-assistant-0.2.0.tgz（13 个文件 / 约 57 kB）
cd ~/.dsh/profiles/web
npm install /绝对路径/dsh-learning-assistant-0.2.0.tgz
```

> dsh 从 **profile 目录**解析裸包名（`~/.dsh/profiles/web/`），不是从安装 dsh 的目录，
> 所以插件必须能被 profile 的 `node_modules` 找到。

## 打包与发布

```bash
npm run verify     # 产物校验 + 全量断言（prepack 会自动跑，失败则打包中止）
npm pack           # 产出 tarball：13 个文件，约 57 kB
npm publish        # publishConfig 已指向 registry.npmjs.org
```

所有工具脚本的路径都从自身位置解析（`import.meta.url`），不写死绝对路径——搬目录、装到别处都不会失效。

`files` 是白名单，`tools/`（构建与探针）不进包——包内只放运行所需。

## 目录规范

| 路径 | 作用 | 进包 |
|---|---|---|
| `package.json` | 包元数据 + `dsh.bundle` / `dsh.client` 声明 | ✅ |
| `cordis.patch.yml` | 唯一的 Host 行（Client 半由 `dsh.client` 自动加载） | ✅ |
| `lib/index.js` | Host 半（ESM）：工具、提示段、HTTP 路由、补充解释 | ✅ |
| `lib/client.js` | Client 半（构建产物，`window.__ModuleLoader__` 格式） | ✅ |
| `lib/client.template.js` | Client 打包模板（构建输入） | ✅ |
| `lib/core/*.js` | 两端共享的 CommonJS 纯逻辑 | ✅ |
| `icon.svg` | 插件市场图标（纯几何，无文字） | ✅ |
| `README.md` / `CHANGELOG.md` / `LICENSE` | 文档与许可 | ✅ |
| `tools/build-client.mjs` | 把 `core/*.js` 内联成 `lib/client.js` | ❌ |
| `tools/selfcheck.mjs` | 两端断言（40+ 项） | ❌ |
| `tools/probe-*.mjs` | 无头浏览器探针（滚动/几何/交互/知识树） | ❌ |
| `.gitignore` | 排除 node_modules / tarball / 日志 | ❌ |

## 与 dsh 插件规范对照

| 规范要求 | 本包做法 |
|---|---|
| 包名 `dsh-plugin-*` + `dsh-plugin` 关键词 | `dsh-learning-assistant`，keywords 含 `dsh-plugin` |
| `type: module`、`main`/`exports` 指向构建产物 | `main: lib/index.js`；`exports` 含 `.`、`./client`、`./cordis.patch.yml` |
| 双面插件：Host 行 + `dsh.client` 声明 | `dsh.bundle.patch` + `dsh.client.platform: web` |
| Client 半必须是构建产物 | `lib/client.js` 由 `npm run build` 生成，`--check` 防漂移 |
| 版本与 Node 约束 | `engines.node ^22.19 || >=24`、`engines.dsh >=0.2.0-rc.2` |
| 发布前自检 | `prepack` → `verify` |

## 已知限制

- 状态每 5 秒轮询一次，不是推送；本地文件很小，开销可忽略。轮询在 `apply` 里跑，与面板是否打开无关——否则面板和高亮都会一直空着。
- 面板是**右侧栏标签页**，不是中间主区域：`main` 插槽会整块替换对话（用户反馈"盖住原对话"），所以不再使用它。
- 入口是**对话头部按钮**而非右栏标签本身：右栏未展开时标签不可见，没有词条时更不会自动弹出——按钮保证任何会话里都能一键打开。
- 右栏展开会压缩对话宽度；折叠/展开用对话头部右侧的侧栏开关，或点标签条上的关闭。
- **时序**：平滑滚动的时长不可预测，所以两处都等"滚动真正停下"再动作——`guide.waitForScrollSettle()`（`scrollend` + 静默轮询 + 1.6s 兜底）。面板侧滚到位后再校验一次居中偏差（>12px 就即时补正）；正文侧先滚、等停、再开始脉冲，否则 3 段闪烁会在半路就烧完。
- 双向定位靠事件 + 模块级交接：点击词由高亮层的 `onOpen(term)` 写入 `store.focus = { term, nonce }`，面板在 effect 里按 `[data-learning-assistant-card]` 找到卡片并 `scrollTo` 居中；双击卡片调用高亮层的 `flash(term)`，后者用独立高亮层 `learning-assistant-flash` 亮灭三次。卡片/滚动区锚点：`[data-learning-assistant-card]`、`[data-learning-assistant-scroll]`。
- 滚动由面板自己负责：dsh 的右栏标签体是 `height:100%; overflow:hidden`（只裁不滚），所以根节点固定 `height:100%` + flex 列，表头 `flex:0 0 auto`，列表区 `flex:1; min-height:0; overflow-y:auto`。调试锚点：`[data-learning-assistant-panel]`、`[data-learning-assistant-scroll]`。
- 正文高亮只标记**已在记忆里的词**（不标记内置词库），且只扫 `[data-conversation-scroll]` 内的散文节点，跳过 `code/pre/textarea` 与插件自身 UI。
- 高亮用 CSS Custom Highlight API：不支持的浏览器自动降级为"只有面板，无正文标记"。
- 观察器挂在 `document.body` 上而不是滚动容器：切换会话会替换容器，挂旧节点会静默失效。
- 自动打开只在"词条集合增长"时触发；首次加载只填充不抢视图。
- 未做"选中一段文字→一键解释"的手势面（`conversation.chat.text-interaction` 槽位已确认可用，后续可加）。
- 外链：优先开在右栏的 `browser` 标签；本部署的 web 组合**没有注册 browser 类型**，因此回退到 `window.open`（桌面版会交给系统浏览器）。弹窗被拦截时会自动复制链接并在面板顶部提示，不会跳转当前页面。
- 判定质量取决于模型；严格度与水平档位是最有效的两个调节旋钮。
