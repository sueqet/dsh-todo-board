# dsh-todo-board

**A cross-session TODO board for DeepSeek Harness — hand the agent one task at a time, and it picks up the next one by itself.**

**DeepSeek Harness（DSH）的跨会话 TODO 板 —— 一次只派一件事，干完它自己去拿下一件。**

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4f6ef7)](https://github.com/topics/dsh-plugin)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19.0-43853d)](package.json)

---

## 它解决什么 / Why

让 AI 干完一件事之后，自己去待办板里找同一目录下还没做完的下一件继续干 —— 不用你盯着逐个验收，也不用一次性把一堆任务塞给它、结果每件都做得半吊子。

Let the agent finish one thing, then look up the next unfinished task **in the same working directory** and keep going. No babysitting each step, no dumping a pile of tasks on it at once and getting five half-done jobs back.

## 安装 / Install

```sh
dsh plugin --profile web add dsh-todo-board          # 发布到 npm 之后 / once published to npm
dsh plugin --profile web add <git-url-or-path>       # 或直接从仓库/目录安装 / or from a repo or local path
```

安装后**重启 Profile**（重新执行 `dsh web`）才会装载 —— 本插件是 host 组合里的一行，不是运行时热加载。

Restart the profile afterwards (`dsh web` again): the plugin is a row in the host composition, not a runtime hot-load.

卸载 / Uninstall:

```sh
dsh plugin --profile web remove dsh-todo-board
```

## 快速上手 / Quick start

1. 右上角出现浮窗，输入一条待办，选执行模式，点「添加」。
2. 让 AI 去做这件事。它做完会调用 `todo_board action=done` 给自己打左勾，然后查同目录下一条。
3. 你验收后点右勾；底部「清理已验收」批量清掉。

1. Type a task into the floating panel, pick a run mode, hit add.
2. Let the agent work. When it finishes it calls `todo_board action=done` to tick its own box, then looks for the next task in the same directory.
3. After you verify, tick the right-hand box; "清理已验收" clears the verified ones.

## 三档执行模式 / Run modes

每条待办在新增时必须选一档（默认「提醒」）。Each task carries exactly one mode, chosen when you add it.

| 模式 | 行为 | Behaviour |
| --- | --- | --- |
| 提醒 | 不自动做任何事，等你在浮窗里点 ▶ | Nothing automatic; you press ▶ when you want it |
| 自动续跑 | AI 回合结束时，把同目录下一条待办注入**当前会话**继续跑 | At turn end, inject the next task in the same directory into the **current session** |
| 自动新会话 | AI 回合结束时，新建一个同目录会话并执行该待办 | At turn end, create a **new session** in the same directory and run the task there |

派发顺序 = 面板里**从上到下**的顺序。拖动行首 `⠿` 调整，顺序持久化。

Dispatch order is the panel's **top-to-bottom** order. Drag the `⠿` handle to change it; the order is persisted.

## 双勾选 / Two checkboxes

| 勾 | 谁勾 | 含义 |
| --- | --- | --- |
| 左（方框） | 模型自己调 `todo_board action=done`，也可手点 | AI 已完成，等你验收 |
| 右（圆框） | 只有用户 | 已验收，真正了结 |

只有**右勾**才把待办从未完成列表里移除。系统提示段落明确禁止模型代勾右勾。

Only the right-hand box closes a task. The prompt section explicitly forbids the model from ticking it.

## 面板操作 / Panel

- **拖动 / 缩放**：拖标题栏移动，右下角 `◢` 缩放；位置与尺寸存进 `localStorage`，刷新保留；双击标题栏或拖柄还原。
- **筛选**：当前目录 / 当前会话 / 全部，每段带未完成计数。
- **行内编辑**：双击标题改名；点模式标签在 提醒 → 续跑 → 新会话 之间循环切换。
- **多行输入**：新增框自动增高（3 行起步，最高 180px），`Enter` 添加、`Shift+Enter` 换行。

## 模型工具 / The `todo_board` tool

| action | 作用 |
| --- | --- |
| `list` | 列出当前工作目录下未验收的待办（`all: true` 列全部目录），带 id 与执行顺序 |
| `add` | 新增一条（追加到列表底部） |
| `done` | 打左勾「AI 已完成」 |
| `reopen` | 撤销左勾 |
| `note` | 追加备注 |

工具输出 schema 是 `additionalProperties: false` 的严格 JSON Schema，返回值只含声明过的字段。

## 数据 / Data

`${DSH_HOME}/todo-board/board.json`（默认 `~/.dsh/todo-board/board.json`），原子写入（临时文件 + rename）。文件缺失时自动创建；读坏或写失败会在浮窗底部红字提示。待办板是全局的，面板内按目录分组。

## 会话生命周期 / Session lifecycle

「自动新会话」创建的会话走 `ctx.root` + `agentPresets.mount()`：

- 归属**应用根上下文**而不是本插件行，因此停用 / 更新 / 卸载本插件不会连带拆掉这些会话；
- `setup` 里挂载 agent preset，与 api-proxy 创建会话的方式一致 —— 少了这一步新会话会没有工具和提示词；
- 模型优先沿用来源会话的 provider/model，否则取 `agentDefaultModel` 的当前选择。

## 结构 / Layout

```
package.json          dsh.bundle.patch → cordis.patch.yml；dsh.client.platform = web
cordis.patch.yml      向 profile 树 insert 一行 todo-board
lib/index.js          Host：板文件、todo_board 工具、回合结束钩子、提示词段落、/dsh-todo-board/api
client/client.js      Browser：shell.overlay 浮窗，走 fetch 访问上面的路由
tools/smoke.mjs       Host 半边自检（stub ctx + 临时 DSH_HOME）
```

Host 半刻意不 import 任何 `@deepseek-ai/*`：profile 安装的插件从自身目录解析模块，harness 包在那里不可达，一切通过 `ctx`。

## 开发 / Development

```sh
npm run check   # node --check 两个入口
npm test        # host 半边 smoke 自检
```

改完客户端只需刷新页面；改 Host 半边需要重启 Profile。

## 已知限制 / Limitations

- 浮窗每 2.5s 轮询一次 `/dsh-todo-board/api`，不是推送。
- 待办板是全局单文件，不按目录分文件。
- 「自动新会话」需要待办上的目录路径可创建。

## License

[MIT](LICENSE)
