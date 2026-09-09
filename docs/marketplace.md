# 提交到 DSH 插件市场 / Submitting to the DSH plugin marketplace

- 市场目录仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- 收录规则：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

## TL;DR

**一个 PR 只加一个文件**：`data/plugins/sueqet__dsh-todo-board.yml`。两个 README 是脚本生成的，**不要手工改**。

本仓库（`sueqet/dsh-todo-board`）创建于 **2026-09-09 07:25 UTC**，CI 有「仓库满 1 天」的门槛，所以最早可提交时间是 **2026-09-10 07:25 UTC**。

## 前置条件核对

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 会被拒） | ✅ `dsh.bundle.patch → ./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 仓库含真实可用代码 | ✅ `lib/index.js`、`client/client.js` |
| 仓库创建满 1 天 | ⏳ 2026-09-10 07:25 UTC 之后 |
| 仓库带 GitHub topic `dsh-plugin` | ✅ 已设（另有 `deepseek-harness` / `dsh` / `cordis` / `todo` / `task-board`） |
| `@deepseek-ai/*` 用 `peerDependencies`，预发布范围带显式分支 | ✅ 只有 `@deepseek-ai/cordis: ^4.0.1`（非预发布） |
| 描述属实、不带营销词 | ✅ |

## 投稿步骤

### 1. Fork 目录仓库

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-sueqet-dsh-todo-board
```

### 2. 新建一个文件

路径：`data/plugins/sueqet__dsh-todo-board.yml`（`<owner>__<repo>.yml`，两个下划线）

```yaml
url: https://github.com/sueqet/dsh-todo-board
name: sueqet/dsh-todo-board
category: ui
description:
  en: 'Cross-session TODO board: a draggable floating panel groups tasks by working directory, each task carries one of three run modes (remind, auto-continue in the current session, auto-open a new session) and two checkboxes (AI done, user verified), and the agent picks up the next unfinished task in the same directory when it finishes one.'
  zh: 跨会话 TODO 板：可拖动浮窗按工作目录分组，每条待办带三档执行模式（提醒 / 自动续跑 / 自动新会话）与双勾选（AI 完成 / 用户验收），AI 完成一项后自动接续同目录下一条未完成待办。
```

要点：

- `url` 必须与仓库完全一致；
- 英文描述含 `: `（冒号加空格）**必须加引号**，否则 YAML 会当成嵌套键；
- 只有 `description.en` 必填，中文可省（维护者会补）；
- `category` 选最贴合的那个，不准也不会被打回（维护者直接改）。本项目最接近的是 **`ui`**（浮窗面板）；如果更看重「自动接续工作流」，`workflow` 也说得通。
- 一个 PR 最多 3 条，本仓库只有这 1 条。

### 3. 提交 PR

```sh
git add data/plugins/sueqet__dsh-todo-board.yml
git commit -m "Add sueqet/dsh-todo-board"
git push -u origin add-sueqet-dsh-todo-board
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add sueqet/dsh-todo-board" \
  --body "Adds sueqet/dsh-todo-board — a cross-session TODO board with a draggable floating panel and three run modes (remind / auto-continue / auto-open a new session). Declares dsh.bundle in package.json; repo has the dsh-plugin topic."
```

## CI 会依次检查

1. **条目数量** ≤ 3（最先跑，早于任何网络请求）；
2. **`dsh.bundle`** —— 从你仓库 `package.json` 读（根包或 `packages/`、`plugins/`、`apps/` 子包），只声明 `dsh.client` 会在这里失败；
3. **仓库年龄** ≥ 1 天；
4. **`awesome-lint` + 站点构建** —— 双语一致性、分隔符、日期、截图。

任何一项失败都会在 PR 里指出要改什么，**在同一个分支上推修复即可**，不用重开 PR。

## 可选增强（不影响收录）

- **截图**：仓库根放 `screenshots.json`（`["assets/screenshot-1.png"]`，1–8 张，相对路径不能以 `/` 开头、不能含 `..`），市场详情页会像 App Store 那样展示；不声明则从 README 自动抽取。
- **npm 发布**：`npm publish` 后市场可显示并按下载量排序；包的 `repository` 字段必须指回本仓库。不发布也能正常安装。

## 合并之后

目录仓库的站点会自动重建，之后在 dsh-market 里就能搜到并一键安装。

## 后续维护

- 定期扫描会标记仓库消失、已归档或长期停更的条目，确认后移除；
- 更新自己条目时**只改自己那一个文件**，别手工动 README（列表增长会让行号移位，改动容易落到邻居身上）。
