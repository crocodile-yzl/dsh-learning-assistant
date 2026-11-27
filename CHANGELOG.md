# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-11-25

### Added

- **划词解释**：在对话正文里选中一段文字，选区旁出现「解释这个词」。已收录的词直接打开
  右栏卡片；新词由宿主调用模型生成解释与学习路径后入库，并标「划词添加」。
  走 dsh 的 `conversation.chat.text-interaction` 槽位，新增 `POST /learning-assistant/explain`
  （带上选区前后各 200 字做消歧；选区超过 60 字返回 413）。
- **学习路径可单击**：卡片里加粗的路径节点一键填进聊天框（`inputActions.insertText`，
  带选区版本守卫，连点 400ms 内去重），方便接着追问。
- 记忆文件无法解析时移到 `terms.json.corrupt-<时间>` 并以空记忆继续；面板提示备份位置，
  一次成功写入后提示消失。
- `GET /state?since=<updatedAt>`：版本未变时返回 `{ unchanged: true }`，不再整表重传；
  页面隐藏时跳过轮询，回到前台立即补拉。
- 配置项 `supplementDebounceMs`、`supplementCooldownMs`（默认 2500 / 15000）。

### Changed

- **术语名归一化**（`guide.termKey`：NFKC + 小写 + 空白折叠）。判重、`parent` / `related`、
  知识树、对话过滤、正文闪烁统一按归一化键查找；显示名保留首次拼写。`VLA` / `vla` / `ＶＬＡ`
  不再是三个互不相连的词条。
- 自动补充的锁改为**按会话**：一个对话的长回答不再让其他对话静默；全局并发上限 2。
- 一轮补充只合并写入一次；传给模型的已收录词按出现次数排序（`guide.mostFamiliar`）。
- 路由 500 只回传固定文案，细节留在日志。

### Fixed

- CI：没有安装 dsh 的环境下，自检在导入 `@deepseek-ai/dsh-tools` 时直接退出。现在仅在解析
  失败时改用 `tools/stubs/dsh-tools.mjs`，有 dsh 的机器仍用真实实现。
- 模型回复「含数组的对象」时被误判成数组，划词解释拿不到结果。
- 记忆缓存只比对 mtime，同一毫秒内的重写会继续读到旧内容；增加 size 比对。

### Removed

- `extractCandidates` / `ACRONYM_STOPWORDS`：0.2.0 的正则候选，0.3.2 改由模型选词后已无调用方。

## [0.3.2] — 2026-11-14（补录）

- 选词改模型驱动，覆盖 ViT / CLIP / Transformer 等正则抓不到的词。

## [0.3.1] — 2026-11-14（补录）

- 精简系统提示（15KB → 650B）并加 3s 缓存，修复思考变慢。

## [0.3.0] — 2026-11-14（补录）

- 改名 `dsh-plugin-term-guide` → `dsh-learning-assistant`；路由 `/learning-assistant`；
  记忆目录迁移到 `$DSH_HOME/dsh-learning-assistant/terms.json`。

## [0.2.1] — 2026-11-14

### Added
- 面板默认**只显示本对话涉及的词**：记忆仍是全局的（跨对话不重复解释），但展示按当前对话过滤。
  顶部「本对话 N / 全部 M」可一键切到全部记忆。
- 纯函数 `guide.filterTermsForText()`（大小写不敏感；空对话返回空；拿不到对话容器时退回全部）。
- 对话标题栏常驻「术语 N」按钮，作为与内容状态无关的入口。

### Fixed
- 无词条时插件不可达：只注册右侧栏标签时，右栏未展开就没有入口。

## [0.2.0] — 2026-11-14

### Changed
- **判定改为「事后补充」**：不再要求模型必须调用工具，模型照常回答即可。
  回答结束后，Host 扫描正文里出现、但记忆尚未收录的专业缩写，自己调用一次
  模型生成解释、学习路径和隶属关系，写入记忆。
- 系统提示相应放宽：明确告诉模型「不要为了配合工具改变回答方式」。
- 术语数量上限与提示/ schema 对齐（4）。

### Added
- 确定性候选抽取 `guide.extractCandidates()`：三字母以上、带字母边界、
  内置通用缩写停用表（AI/API/CPU/LLM…），按出现频次排序。
- 补充解释带上「用户的原问题」做消歧（`VLA` 在 C 话题与机器人话题下取义不同）。
- 模型可用 `{"skip": true}` 拒绝非术语候选（语言标准编号、代码标识符等）。
- 卡片上以「自动补充」标签区分模型主动记录与插件补齐的词条。
- 包结构规范化：`icon.svg`、`LICENSE`、`CHANGELOG.md`、`scripts`
  （build / check / test / verify / prepack），`npm pack` 内容显式声明。

## [0.1.0] — 2026-11-13

### Added
- Host 半：`explain_terms` 工具、系统提示段、`/learning-assistant` HTTP 路由、
  `$DSH_HOME/dsh-learning-assistant/terms.json` 记忆文件。
- Client 半：右侧栏「术语」标签、词条卡片、知识树视图、正文高亮
  （CSS Custom Highlight）、点击词定位卡片、双击卡片闪烁正文。
- 双向定位的滚动校正（`waitForScrollSettle` + 落点复核）。
- 自检脚本覆盖两端共 40+ 断言，以及无头浏览器探针。
