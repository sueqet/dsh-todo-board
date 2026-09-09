# 提交到 DSH 插件市场 / Submitting to the DSH plugin marketplace

市场目录：[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
规则见其 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

## 1. 仓库先满足前置条件

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（只有 `dsh.client` 不算） | ✅ `dsh.bundle.patch → ./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 仓库有真实可用代码 | ✅ |
| 仓库创建满 **1 天**（CI 自动检查） | ⏳ 新建仓库当天不满足，第二天再提 |
| 仓库加上 GitHub topic **`dsh-plugin`** | ⏳ 需要手工加（MCP 工具没有改 topic 的接口） |
| `@deepseek-ai/*` 用 `peerDependencies` 且预发布范围要带显式分支 | ✅ 只声明了 `@deepseek-ai/cordis: ^4.0.1`（非预发布，无需分支） |

加 topic：

```sh
gh repo edit sueqet/dsh-todo-board --add-topic dsh-plugin
```

或网页：仓库页 → 右上 About 齿轮 → Topics 填 `dsh-plugin`。

## 2. 提一个 PR，只加一个文件

文件路径：`data/plugins/sueqet__dsh-todo-board.yml`

```yaml
url: https://github.com/sueqet/dsh-todo-board
name: sueqet/dsh-todo-board
category: ui
description:
  en: 'Cross-session TODO board: a draggable floating panel groups tasks by working directory, each task carries one of three run modes (remind, auto-continue in the current session, auto-open a new session) and two checkboxes (AI done, user verified), and the agent picks up the next unfinished task in the same directory when it finishes one.'
  zh: '跨会话 TODO 板：可拖动浮窗按工作目录分组，每条待办带三档执行模式（提醒 / 自动续跑 / 自动新会话）与双勾选（AI 完成 / 用户验收），AI 完成一项后自动接续同目录下一条未完成待办。'
```

要点：

- **只加这一个文件**，不要手工改 `README.md` / `README.zh.md`（它们是生成的）。
- 一个 PR 最多 3 条；这是本仓库唯一一条。
- 描述必须与代码相符 —— 上面的描述只陈述实际行为，没有数字和营销词。
- `category` 可选项里最接近的是 `ui`（面板/浮窗）与 `workflow`（自动接续）。维护者会在分类不准时直接改，不会打回。

## 3. 可选增强

- **截图**：在仓库根放 `screenshots.json`（`["assets/screenshot-1.png"]`，1–8 张，相对路径不能跳出插件目录），市场详情页会展示；不声明则自动从 README 抽取。
- **npm 发布**：`npm publish` 后市场的下载量排序会生效；包的 `repository` 字段必须指回本仓库。不影响收录。

## 4. 提交后

CI 依次检查：条目数量 → `dsh.bundle` → 仓库年龄 → `awesome-lint` + 站点构建。失败会指出要改什么，在同一个分支上推送修复即可，不用重开 PR。
