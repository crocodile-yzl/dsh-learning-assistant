# dsh-learning-assistant · 学习助手

> 模型照常回答，插件补它没解释的**专业术语**：自动记进记忆、按对话过滤展示，右侧栏知识树 + 正文高亮 + 一句话解释与学习路径。越用越懂你已经会了什么。

## 它做了什么

1. **判断**：Host 半往系统提示里注入一段规则——结合「你的水平档位」「解释倾向严格度」「记忆里你已经见过的词」，判断本次回答里哪些词值得解释。没有需要解释的词就不调用。
2. **记录**：两条路，结果写进同一份记忆 `$DSH_HOME/dsh-learning-assistant/terms.json`：
   - 模型主动调用 `explain_terms` 工具；
   - 回答结束后，Host 半让模型挑出正文里没解释清楚的专业词，自己补齐解释（卡片标「自动补充」）。
   重复出现的词会累加 `count`（这是"你可能已经学会了"的证据）。
3. **划词解释**：你在正文里选中一段文字，选区旁出现「解释这个词」。已收录的词直接打开卡片；新词当场生成解释与学习路径并入库（标「划词添加」）。
4. **呈现**：**对话标题栏常驻一个「术语 N」按钮**（N = 全局词条数），点它打开右侧栏标签页。面板默认**只列本对话涉及的词**（记忆本身是全局的，跨对话不会重复解释），顶部可切「本对话 / 全部」。面板有「词条 / 知识树」两个视图：
   - **词条**：每个词一张卡片——解释、缩进学习路径、隶属/延伸跳转、维基/Google/Bing 外链；
   - **知识树**：按「隶属 → 延伸」组织的层级视图，节点显示分类与「延伸 N」，点击任一节点回到词条视图并定位。
5. **学习路径可单击**：卡片里加粗的路径节点，单击就把这个概念填进聊天框，接着往下问。
6. **正文高亮**：已在侧栏有词条的术语，在对话正文里自动标记（淡蓝底 + 虚线下划线）。纯视觉层——没有悬浮气泡；**点击标记**会打开右侧栏并**自动滚动到该词卡片**（卡片同时脉冲两次）。
7. **自动呈现**：新词入库时，右侧栏会**自己展开**并切到「术语」标签（首次加载不会抢视图，只有词条集合真的增长时才开）。
8. **反向定位**：**双击侧栏卡片**，正文里该词的**所有出现位置一起闪烁三次**（琥珀色），若不在视口内先把第一处滚到中间。
9. **自适应**：用户连续追问同一个概念时，模型会把 `strictnessAdjust` 设为 +10，以后更倾向于解释。

同一个词的大小写、全角/半角、空白差异视为同一个词（`VLA` / `vla` / `ＶＬＡ` 合并计数，显示名保留首次拼写）。

## 架构

```
lib/index.js         Host 半（ESM）
  ├─ explain_terms 工具       ctx.tools.register(defineTool(...))
  ├─ 系统提示段落             ctx.systemPrompt.section(...)（动态读取记忆，3s 缓存）
  ├─ 自动补充                 session/event → 防抖 → 模型选词 → 一次合并写入（按会话加锁）
  ├─ HTTP 路由 /learning-assistant/*  ctx.webServer.register({kind:'prefix'})
  └─ 记忆文件                 $DSH_HOME/dsh-learning-assistant/terms.json

lib/client.js        Client 半（构建产物，window.__ModuleLoader__ 格式）
  ├─ 常驻入口        ctx.slots.register('conversation.session.header.actions') → 「术语 N」按钮
  ├─ 标签类型        ctx.sidebarRightTabs.register({ id, kind, title })
  ├─ 标签主体        ctx.slots.register({ name: 'sidebar.right.pane.tab', key })
  ├─ 划词手势        ctx.uiConversation.interactions.register(...)
  │                  + ctx.slots.register({ name: 'conversation.chat.text-interaction', key })
  └─ 轮询 /learning-assistant/state（5s + 窗口聚焦；页面隐藏时暂停）

lib/core/guide.js    两端共享的纯逻辑（归一化 termKey / 合并 / 知识树 / 外链模板）
lib/core/highlight.js  正文高亮：CSS Custom Highlight + 点击命中（无悬浮气泡）
lib/core/shell.js    Client 源码（React.createElement，无 JSX）
tools/build-client.mjs   把 core/*.js 内联进 lib/client.template.js → lib/client.js
tools/selfcheck.mjs      两端功能自检（100+ 断言；无 dsh 环境自动使用 tools/stubs/dsh-tools.mjs）
tools/probe-*.mjs     无头浏览器探针（需要 playwright-core，不随包发布）
```

## 安装

dsh 的「设置 → 插件 → 添加插件」接受三种输入：**npm 包名**、**GitHub 仓库地址**、**本地目录路径**。
本包三种都支持，其中本地目录路径**无需发布**即可安装。

前提：`pnpm` 在 dsh 进程的 PATH 里（插件管理器用 `pnpm add` 安装）。

### 方式 A：一键脚本 / 官方命令（推荐）

```bash
./install.sh                              # 装到 web profile（幂等）
./install.sh tui                          # 装到别的 profile
DSH_BIN=/path/to/dsh ./install.sh         # dsh 不在 PATH 时

# 等价的手动命令
dsh plugin --profile web add /绝对路径/dsh-learning-assistant   # 本地目录
dsh plugin --profile web add dsh-learning-assistant              # npm 包名
dsh plugin --profile web add https://github.com/crocodile-yzl/dsh-learning-assistant
```

这条命令做三件事：把包写进 profile 的 `dependencies`、把它加进 `dsh.profile.bundles`、让 pnpm 建立 `node_modules` 链接。**装完即生效，启动不需要 `--patch`**。

### 方式 B：手动软链（只调试、不走管理器）

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn /绝对路径/dsh-learning-assistant ~/.dsh/profiles/web/node_modules/dsh-learning-assistant
```

此时 profile 里没有 bundle 记录，启动要显式带 patch（见「启用」）。

### 方式 C：从 tarball 安装（离线分发）

```bash
npm pack                                                   # dsh-learning-assistant-0.4.0.tgz
cd ~/.dsh/profiles/web && pnpm add /绝对路径/dsh-learning-assistant-0.4.0.tgz
```

> dsh 从 **profile 目录**解析裸包名（`~/.dsh/profiles/web/`），不是从安装 dsh 的目录，所以插件必须能被 profile 的 `node_modules` 找到。

### 装载后的检查清单

| 步骤 | 命令 / 现象 |
|---|---|
| 1. profile 是否登记 | `node -e "console.log(require(process.env.HOME + '/.dsh/profiles/web/package.json').dsh.profile.bundles)"` 里应含 `dsh-learning-assistant` |
| 2. 启动（无需 `--patch`） | `dsh web --no-open --port 3080` |
| 3. 取访问地址 | `tail -n 3 <日志>`，形如 `http://127.0.0.1:3080/?token=…` |
| 4. 后端是否加载 | `curl -b <cookie> http://127.0.0.1:3080/learning-assistant/state` → 200 + JSON |
| 5. 前端是否加载 | 对话标题栏出现「术语 N」按钮；在正文划选一段文字，出现「解释这个词」 |
| 6. 端到端 | 问一个含专业缩写的问题，回答后侧栏应出现该词（标「自动补充」）；点学习路径里加粗的概念，聊天框出现该文字 |

### 更新

- **本地目录装法**（`link:` 依赖）：重跑 `./install.sh`，重启 dsh 生效。
- **npm 包装法**：`dsh plugin --profile web add dsh-learning-assistant@latest` 后重启。
- 卸载：`dsh plugin --profile web remove dsh-learning-assistant`。

## 启用（仅手动软链装法需要）

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
node tools/selfcheck.mjs          # 两端 100+ 断言，零依赖
```

在装有 dsh 的机器上，Host 半用的是真实的 `@deepseek-ai/dsh-tools`；在没有 dsh 的 CI 上，自检会改用 `tools/stubs/dsh-tools.mjs`。
`tools/probe-*.mjs` 是无头浏览器探针（滚动/几何/交互/知识树/安装弹窗），需要 `playwright-core` 可被解析——请在装有它的目录下运行（例如 dsh 的安装目录），它们不随包发布。

覆盖：bundle 注册 / slot 注册 / 卡片渲染（含树与外链 `noopener`）/ 学习路径填入聊天框 / 划词动作 / 工具执行 / 记忆落盘 / 术语名归一化 / 坏文件备份 / 划词解释路由 / 自动补充的会话隔离 / 系统提示内容 / HTTP 路由。

## 配置（cordis.patch.yml 的 config）

| 字段 | 含义 | 默认 |
|---|---|---|
| `level` | `beginner` / `intermediate` / `expert`，判定基准 | `intermediate` |
| `strictness` | 0–100，越高越爱解释；面板里的滑杆改的是同一个值 | `50` |
| `autoAdapt` | 预留给模型的自适应开关 | `true` |
| `supplementDebounceMs` | 回答结束后等多久再扫描补充 | `2500` |
| `supplementCooldownMs` | 同一会话两次自动补充的最小间隔 | `15000` |

面板里的「我的水平」「解释倾向」改动会写回记忆文件，优先级高于 config 默认值。

## HTTP 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/learning-assistant/state` | 读取词条 / 水平 / 严格度；带 `?since=<updatedAt>` 且版本未变时返回 `{ unchanged: true }` |
| POST | `/learning-assistant/level` | `{ level }` |
| POST | `/learning-assistant/strictness` | `{ value }` |
| POST | `/learning-assistant/forget` | `{ term }` 移除一个词条（按归一化名匹配） |
| POST | `/learning-assistant/explain` | `{ term, context }` 划词解释：已收录直接返回；新词调模型后入库。超过 60 字返回 413 |
| POST | `/learning-assistant/clear` | 清空词条 |

## 数据模型

`terms.json` 的每个词条除 `term` / `explanation` / `tree` / `links` / `count` 外，还可能有：

| 字段 | 含义 |
|---|---|
| `parent` | 它从哪个已收录词延伸出来（知识树的上级）。缺失或指向未收录词时，该词作为根节点，并标注「隶属 X（未收录）」 |
| `related` | 同层或强相关词的名称，卡片上以 `↔` 芯片展示 |
| `source` | `supplement`（插件自动补充）/ `manual`（划词添加）；模型主动记录的词没有这个字段 |

`parent` / `related` 的匹配、词条判重、知识树挂载、对话过滤、正文闪烁都按归一化键（NFKC + 小写 + 空白折叠）进行，所以拼写差异不会把一个词拆成几条。树的构建（`guide.buildKnowledgeTree`）对环、缺失父级、重复挂载都做了保护，最多 9 层。

记忆文件无法解析时，会被移到 `terms.json.corrupt-<时间>`，插件以空记忆继续，并在面板里提示备份位置。

## 打包与发布

```bash
npm run verify     # 产物校验 + 全量断言（prepack 会自动跑，失败则打包中止）
npm pack           # 产出 tarball
npm publish        # publishConfig 已指向 npmjs
```

所有工具脚本的路径都从自身位置解析（`import.meta.url`），不写死绝对路径。

## 目录规范

| 路径 | 作用 | 进包 |
|---|---|---|
| `package.json` | 包元数据 + `dsh.bundle` / `dsh.client` 声明 | ✅ |
| `cordis.patch.yml` | 唯一的 Host 行（Client 半由 `dsh.client` 自动加载） | ✅ |
| `lib/index.js` | Host 半（ESM）：工具、提示段、HTTP 路由、自动补充、划词解释 | ✅ |
| `lib/client.js` | Client 半（构建产物，`window.__ModuleLoader__` 格式） | ✅ |
| `lib/client.template.js` | Client 打包模板（构建输入） | ✅ |
| `lib/core/*.js` | 两端共享的 CommonJS 纯逻辑 | ✅ |
| `icon.svg` | 插件市场图标（纯几何，无文字） | ✅ |
| `README.md` / `CHANGELOG.md` / `LICENSE` | 文档与许可 | ✅ |
| `install.sh` | 一键安装脚本 | ✅ |
| `tools/build-client.mjs` | 把 `core/*.js` 内联成 `lib/client.js` | ❌ |
| `tools/selfcheck.mjs` | 两端断言 | ❌ |
| `tools/stubs/dsh-tools.mjs` | 自检在无 dsh 环境下的 `defineTool` 替身 | ❌ |
| `tools/probe-*.mjs` | 无头浏览器探针 | ❌ |

## 与 dsh 插件规范对照

| 规范要求 | 本包做法 |
|---|---|
| 包名 + `dsh-plugin` 关键词 | `dsh-learning-assistant`，keywords 含 `dsh-plugin` |
| `type: module`、`main`/`exports` 指向构建产物 | `main: lib/index.js`；`exports` 含 `.`、`./client`、`./cordis.patch.yml` |
| 双面插件：Host 行 + `dsh.client` 声明 | `dsh.bundle.patch` + `dsh.client.platform: web` |
| Client 半必须是构建产物 | `lib/client.js` 由 `npm run build` 生成，`--check` 防漂移 |
| 版本与 Node 约束 | `engines.node ^22.19 \|\| >=24`、`engines.dsh >=0.2.2-rc.1`（划词槽位与 `inputActions` 从这版起可用） |
| 发布前自检 | `prepack` → `verify` |

## 已知限制

- 状态每 5 秒轮询一次，不是推送；版本未变时主机只回一句 `unchanged`，页面隐藏时不轮询。
- 面板是**右侧栏标签页**，不是中间主区域：`main` 插槽会整块替换对话（用户反馈"盖住原对话"），所以不再使用它。右栏展开会压缩对话宽度；折叠/展开用对话头部右侧的侧栏开关，或点标签条上的关闭。
- 划词动作只认**有文字的划选**，不响应右键；选区超过 60 字会在面板里提示而不解释。
- 学习路径填入的是节点文字本身（不是一整句问法）；聊天框正在发送时编辑器是只读的，面板会提示「等它空闲」。
- **时序**：平滑滚动的时长不可预测，所以两处都等"滚动真正停下"再动作——`guide.waitForScrollSettle()`（`scrollend` + 静默轮询 + 1.6s 兜底）。面板侧滚到位后再校验一次居中偏差（>12px 就即时补正）；正文侧先滚、等停、再开始脉冲。
- 双向定位靠事件 + 模块级交接：点击词由高亮层的 `onOpen(term)` 写入 `store.focus = { term, nonce }`，面板在 effect 里按 `[data-learning-assistant-card]` 找到卡片并 `scrollTo` 居中；双击卡片调用高亮层的 `flash(term)`。锚点：`[data-learning-assistant-card]`、`[data-learning-assistant-scroll]`、`[data-learning-assistant-ask]`、`[data-learning-assistant-explain]`。
- 正文高亮只标记**已在记忆里的词**，且只扫 `[data-conversation-scroll]` 内的散文节点，跳过 `code/pre/textarea` 与插件自身 UI。高亮用 CSS Custom Highlight API：不支持的浏览器自动降级为"只有面板，无正文标记"。
- 自动补充每轮会额外调用一次模型（与主回答同一路由）；严格度 ≥70 取 3 词、≤30 取 1 词、其余 2 词；全局最多两路并发。
- 外链：优先开在右栏的 `browser` 标签；本部署的 web 组合**没有注册 browser 类型**，因此回退到 `window.open`。弹窗被拦截时会自动复制链接并在面板顶部提示。
- 判定质量取决于模型；严格度与水平档位是最有效的两个调节旋钮。
