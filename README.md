# dsh-learning-assistant

学习助手：在 dsh 回答中补充专业术语解释，并提供右侧栏词条、知识树、正文高亮和划词解释。

## 功能

- 回答结束后自动补充未解释的专业术语，也可由模型主动记录。
- 选中正文文字即可生成解释与学习路径。
- 右侧栏提供「词条 / 知识树」视图，支持按当前对话过滤。
- 已收录术语在正文中高亮；点击高亮定位卡片，双击卡片定位正文。
- 点击学习路径中的概念，可将其填入聊天框继续提问。
- 支持调整用户水平与解释倾向，词条跨对话记忆。

## 环境要求

- 已验证：**dsh 0.2.2-rc.1，Node.js 22 / 24**。其他 dsh 版本尚未验证。
- 安装过程由 dsh 调用 `pnpm`，请确保 `pnpm` 在 dsh 进程的 PATH 中。
- 从 GitHub 安装时还需要 `git` 在 PATH 中。

插件不附带也不安装 dsh。

## 安装

### 通过 dsh 界面（推荐）

打开「设置 → 插件 → 添加插件」，填入以下地址并安装，完成后重启 dsh：

```text
https://github.com/crocodile-yzl/dsh-learning-assistant
```

### 通过命令行

```bash
dsh plugin --profile web add https://github.com/crocodile-yzl/dsh-learning-assistant
```

本地开发时也可直接安装目录：

```bash
dsh plugin --profile web add <插件目录的绝对路径>
```

卸载：

```bash
dsh plugin --profile web remove dsh-learning-assistant
```

## 使用

1. 正常提问。回答中出现需要解释的术语后，点击对话标题栏的「术语 N」打开右侧栏。
2. 在「本对话 / 全部」之间切换，或切换到「知识树」查看术语关系。
3. 在正文选中文字，点击「解释这个词」添加新词条。
4. 点击正文高亮可定位词条卡片；双击卡片可闪烁正文中的对应术语。
5. 点击卡片学习路径中的概念，将其填入聊天框继续提问。

词条默认保存在 `$DSH_HOME/dsh-learning-assistant/terms.json`；未设置 `DSH_HOME` 时保存在 `~/.dsh/dsh-learning-assistant/terms.json`。

## 配置

默认值位于 `cordis.patch.yml`：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `level` | 用户水平：`beginner` / `intermediate` / `expert` | `intermediate` |
| `strictness` | 解释倾向，0–100，越高越积极 | `50` |
| `autoAdapt` | 是否允许根据追问自适应调整 | `true` |
| `supplementDebounceMs` | 回答结束后的自动补充延迟 | `2500` |
| `supplementCooldownMs` | 同一会话自动补充的最小间隔 | `15000` |

面板中的「我的水平」和「解释倾向」设置优先于默认配置。

## 开发

```bash
npm run build    # 生成 lib/client.js
npm run check    # 检查构建产物是否为最新
npm test         # 运行自检
npm run verify   # 构建检查 + 自检
```

修改 `lib/core/*` 或 `lib/client.template.js` 后，必须运行 `npm run build` 并提交更新后的 `lib/client.js`。从 GitHub 安装时不会代为执行构建。

## 许可证

MIT
