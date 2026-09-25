# dsh-todo-board 本轮修复报告清单

> 版本 **0.6.1**（上一版 0.5.0）· 仓库 `D:\DSH\plugin\dsh-todo-board`
> 对应 issue：https://github.com/sueqet/dsh-todo-board/issues/1

---

## 零、本次会话全部改动一览

### 改动清单（按性质分组）

| # | 改动 | 类型 | 位置 |
|---|---|---|---|
| 1 | 视口变窄时面板被裁到屏幕外（issue #2） | 修 bug | `client/client.js` |
| 2 | 目录输入框的暗色 placeholder 冒充默认值（issue #3） | 修 bug | `client/client.js` |
| 3 | 任务状态维护：未派发/已派发/进行中/已完成/悬住 | 新功能 | `lib/index.js` + client |
| 4 | ▶ 只在「未派发」时可点，其余禁用并说明原因 | 新功能 | `client/client.js` |
| 5 | 悬住原因分类（会话丢失/图片被拒/建会话失败/预设解析失败/服务不可用） | 新功能 | 两侧 |
| 6 | 派发失败不再盖 `dispatchedAt` → 不再永久退役 | 修 bug | `lib/index.js` |
| 7 | 派发失败不再把 host 卡死（微任务死循环） | 修 bug（既存） | `lib/index.js` |
| 8 | 卡住的行按退避重试，且不挡队列 | 新功能 | `lib/index.js` |
| 9 | 每行同一事实只说一遍（目录留小字、定时留标签） | 改进 | `client/client.js` |
| 10 | 已在列表的待办可设置/修改/取消定时 | 新功能 | `client/client.js` |
| 11 | `todo_board list` 增加「状态=」列，`state` 进输出 schema | 改进 | `lib/index.js` |
| 12 | 清掉运行中的 debug 日志代码（会话开始时） | 清理 | `lib/index.js` |
| 13 | **每行都显示状态标签**（0.6.0 只给「需要注意」的状态画标签，导致大多数行看不到状态） | 修 bug | `client/client.js` |

### 测试结果（全部通过）

```
npm run check   → node --check lib/index.js && client/client.js        通过
npm test        → 3 个套件 / 21 个检查点                                全部通过
                   smoke(host) 9 · client-smoke 11 · retry-loop 1
npm run guard   → 2 个变异测试套件 / 8 个变异体                         全部被抓到
                   clamp-guard 2 · row-guard 6
```

### 本轮新增的测试工具

| 工具 | 作用 |
|---|---|
| `tools/retry-loop.mjs` | host 冻结 bug 的回归守卫（已并入 `npm test`） |
| `tools/check-clamp-guard.mjs` | 用变异测试证明「视口夹紧」的测试真的会失败 |
| `tools/check-row-guard.mjs` | 用变异测试证明「事实去重 + 行内改定时」的测试真的会失败 |
| `D:\DSH\plugin\layout-resize-repro.mjs` | issue #2 的独立复现脚本（修复前后对照证据） |

---

## 一、issue #1 四条问题的最终状态

| # | 问题 | 状态 | 说明 |
|---|---|---|---|
| 1 | 折叠按钮 `–` 点不动 | ✅ 已修（0.5.0） | 守卫在 `client.js` 的 `beginDrag`：pointerdown 落在按钮上就不启动拖动，因而不会 `setPointerCapture` 抢走 click |
| 2 | 窗口变窄把面板裁到屏幕外 | ✅ 本轮已修 | 见下方「二」 |
| 3 | 目录输入框误导 | ✅ 本轮已修 | 见下方「三」 |
| 4 | 三个执行模式按钮没说明 | ❌ 决定不修 | 你实测指出：创建待办时可随时切换按钮，下方 `MODE_HINT` 本来就写了触发时机（「AI 一停就…」）。issue 这条不成立 |

**关于 #2 的重要更正**：issue 作者称「只能清 localStorage 才能恢复」是**错的**。实测：拉宽窗口就能看到面板（绝对像素一直在那儿，只是被窗口右边界裁掉）。真正会变得不可恢复的只有一种情况——**你能达到的最大视口宽度永远回不到 `left + width` 以上**（换小屏、长期保持浏览器放大）。我最初转述了 issue 的说法没有实测，这一点已在过程中更正。

---

## 二、issue #2：窗口裁切面板（本轮主任务）

**根因**：位置按绝对像素存 `localStorage`，而夹紧函数只在**拖动/缩放**时被调用；窗口 resize 时没有任何代码重算，全文件 `addEventListener` 出现 0 次。

**修复**（`client/client.js`）：
1. **窗口 resize 时重新夹紧**，并同时监听 `visualViewport`（覆盖浏览器缩放，它不一定触发普通 resize）。
2. **加载时夹紧一次** —— 光刷新页面就能救回被旧会话或大显示器存歪的布局，不必手清 `localStorage`。
3. **「用户选择」与「当前渲染」分开保存**：夹紧只影响显示、不写盘，所以窗口再拉宽时面板回到你放它的地方（与刷新后结果一致），不会因一次缩窗就永久黏在角落。双击标题栏还原依旧有效。
4. 顺带修掉一个自己引入的隐患：`useRef(initialGeometry())` 的参数**每次渲染都会求值**，而面板每 2.5 秒轮询重渲染一次，会反复读 localStorage —— 改为每次挂载只读一次。

**验证**：见「六」。

---

## 三、issue #3：目录输入框

你看到的那行暗色 `目录：D:\DSH` **不是默认值，是 placeholder**（CSS `color:var(--tb-dim);opacity:.85`），输入框实际是空的 —— 你的第一反应正好复现了这个误解，说明它确实误导。

**修复**：保留可编辑（按你的选择，因为该值不仅影响 newSession，还决定分组、目录筛选、以及回合结束后由谁接续），只加紧凑提示：
- 可见标签「目录」（复用「定时」那行的 `.lbl` 样式，不撑高面板）
- placeholder 改为 `留空 = <cwd>`，不再冒充已填好的值
- tooltip 说明它真正决定什么

---

## 四、你的两条新需求

### 4.1 任务状态维护

状态由 host 从**实时会话列表**推导（`todoState()`），**不落盘**——`进行中` 取决于 agent 的实时 status，任何文件都存不住；落盘的状态字段还会与时间戳本身漂移。

| 状态 | 面板 | 含义 |
|---|---|---|
| 未派发 | （无标签） | 还没交给任何会话；▶ 可点 |
| 已派发 | `已派发`（绿） | 已交给会话，目标仍在 |
| 进行中 | `进行中`（蓝） | 目标会话此刻正在跑 |
| 已完成 | （划线） | AI 打左勾，或你打右勾 |
| 悬住 | `目标会话丢失`（红）等 | 见 4.2 |

`todo_board list` 增加「状态=」一列，`state` 也进了输出 schema。

### 4.2 ▶ 派发规则 + 悬住原因分类

**▶ 只在「未派发」时可点**（按你的指定）：已派发、进行中、悬住一律禁用并说明原因。

悬住原因按 `lostKind` 分类，图片被拒时**不会谎称「目标会话丢失」**——会话好着呢，只是模型看不了图：

`目标会话丢失` / `图片被拒` / `建会话失败` / `预设解析失败` / `服务不可用`

### 4.3 修掉「静默卡死」

派发失败原本会盖上 `dispatchedAt`，而该戳正是调度器与回合结束钩子用来**跳过**一条待办的依据 —— 于是定时待办在源会话关闭后会失败、被标记「已派发」、然后**永远不再重试**且不报错。现在失败不盖此戳，改记 `lostAt` 并按退避重试（1 分钟起、逐次翻倍、上限半小时）；改模式/换目录/解绑会话立刻清标记重新排队；卡住的行也不挡队列后面的条目。

### 4.4 每行不重复同一事实 + 已有待办可改定时（追加需求）

**去重**：原先同一件事在一行里说了两遍 —— 目录既是下方标签、又是小字里的完整路径；定时既是小字里的「定时/不定时」、又是下方标签。现在按你指定的方向各留一处：
- **目录**只留小字里的完整路径，行下方的目录标签去掉（它只是把小字里的目录名又说了一遍）。
- **定时**只留下方标签，小字里的「定时/不定时」去掉。

**已有待办可改定时**（此前只能在新增时设定）：
- 未定时的行显示 `🕓 不定时`，点一下就地展开时间选择器。
- 已定时的行点时间标签，打开同一个选择器并**带着当前时间**，可直接改。
- `Enter` 或 `✓` 保存，`Esc` 取消；清空即取消定时。保存走与新增框**完全相同**的 `patch` 通路，没有第二套代码路径。
- 原标签尾部的 `✕` 独立成同级小按钮（按钮不能嵌套控件），仍是一键取消定时。

---

## 五、过程中发现的既存 bug（不在 issue 里）

**派发失败会把 host 卡死。** `armTimer() → fireDue() → .finally(armTimer)` 这条链上，只要有一条到期待办派发失败且**什么都没记**（既无 `dispatchedAt` 也无 `lostAt`），它就永远「到期」，重试链**纯靠微任务自我循环**：事件循环一次都跑不到，计时器永不触发，整个 host 冻结。

- **已复现**：200 次重试、全程不让出事件循环。
- **在 HEAD 上同样复现**，非本轮引入。
- **修复**：所有失败路径（找不到会话、建会话失败、preset 解析失败、图片被拒、agents 不可用）统一走 `markLost()` 退避收敛。

---

## 六、验证清单（全部通过）

### 自动化测试：`npm test`（3 个套件 / 21 个检查点）

| 套件 | 检查点 |
|---|---|
| `tools/smoke.mjs`（host） | apply · order · route · persist · schedule · binding · images · **state** · **stranded** |
| `tools/client-smoke.mjs`（浏览器半侧） | render · sections · drag · park · **clamp** · **runlock** · **lostkind** · **dirfield** · **rowfacts** · **rowsech** · empty |
| `tools/retry-loop.mjs`（新增守卫） | **retry** |

粗体为本轮新增。

### `npm run guard`：两个变异测试套件（6 个变异体全部被抓到）

1. **`tools/check-clamp-guard.mjs`** —— 去掉 resize 监听 / 去掉加载时夹紧，`client-smoke` **都必须失败**。
2. **`tools/check-row-guard.mjs`** —— 恢复目录标签 / 把小字里的定时加回去 / 去掉「不定时」入口 / 让保存不发请求，4 个变异体**全部被抓到**。

两个守卫都会在每条退出路径（含 Ctrl-C）还原 `client.js` 并**逐字节校验**，且先确认「未变异时套件通过」才继续 —— 否则测试有效性无从谈起。注意工作区是 **CRLF**，守卫在 LF 归一化副本上匹配、再映射回原换行符。

### 独立复现脚本（issue #2 的原始证据）

`D:\DSH\plugin\layout-resize-repro.mjs` —— 修复前：缩窗后面板 `left=1532` 而视口仅 1000 宽（不可见）；修复后：

```
--- 2. window is pulled narrow (resize listeners on the client: 1)
    geometry : left=612 top=56 380x600      ← 自动收回视野
    screen   : fully visible
--- 4. window is widened back to the original size
    geometry : left=1532 top=56 380x600     ← 回到你放它的地方
    screen   : fully visible
--- 5. a viewport that will never be wide again
    screen   : fully visible                ← 曾经不可恢复的场景
```

### 手工验证建议

1. **视口夹紧**：把面板拖到最右 → 拉窄浏览器窗口 → 面板应始终可见 → 再拉宽 → 回到原位置。
2. **行内改定时**：找一个「不定时」的行 → 点 `🕓 不定时` → 选时间 → `Enter` → 标签出现该时间；再点标签 → 改时间；点标签旁的 `✕` → 取消。
3. **去重**：任一行应只看到「小字里有目录完整路径、没有目录标签」以及「下方有定时标签、小字里没有定时」。

### 未能完成的验证（如实说明）

`tools/capture-screenshots.mjs` 会启动 headless Chrome 抓真实渲染图，但在本会话沙箱里 Chrome 无法启动（DevTools 端口不可达），所以**本轮没有真实浏览器截图**。渲染结构由 `client-smoke.mjs` 的组件测试覆盖（断言真实 render tree 的类名、文本与事件处理器），但**像素级外观未经我亲眼确认** —— 尤其是新增的 `🕓 不定时` 标签与行内时间选择器的实际排版，建议你刷新面板后看一眼。

---

## 七、需要你注意的事项

### 7.1 浏览器端 vs host 端，生效方式不同 ⚠️

安装目录 `profiles/web/node_modules/dsh-todo-board` 是指向本仓库的 **junction**（`LinkType: Junction`），磁盘上已是新代码。但两半的生效方式不同：

- **浏览器半侧（本轮 issue #2 的修复、行内改定时、去重）**：刷新页面即可。
- **host 半侧（状态推导、悬住分类、失败不置戳、退避重试）**：**必须重启 `dsh web`**。实测证据 —— 正在运行的 host 返回的字段里没有本轮新增项：

```
GET /dsh-todo-board/api 返回的字段：
id, title, dir, ..., dispatchedAt, runSessionId, createdAt, updatedAt
→ state / lostAt / lostKind / lostAttempts / targetAlive 全部 ABSENT
```

### 7.2 未做的事

- issue #4 按你的判断**不修**。
- 本轮所有改动**未提交 git、未发布 npm**（10 个文件变动）。
- 版本号已升到 **0.6.0**（`package.json` 与 `client.js` 的 `BUILD` 标记一致）。

### 7.3 过程失误（如实记录）

1. 我用 PowerShell 做文本替换时把 `client-smoke.mjs` 的 UTF-8 中文写坏，`git checkout` 恢复时**连带丢失了本轮与上一轮该文件的测试代码**，已全部重建并重新验证通过。教训：UTF-8 文件只用编辑工具改，不走 PowerShell 文本管线。
2. 第一版变异检查用 `execFileSync` 配 `stdio: 'pipe'`，在沙箱里命中 `spawn EPERM` —— **失败被误判成「变异被抓到」**，等于假阳性。已改为 `stdio: 'ignore'` 并加「未变异时必须通过」的前置断言。

---

## 八、文件清单

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 状态推导、`markLost`/`clearLost`、退避、输出 schema |
| `client/client.js` | 视口夹紧、状态标签、▶ 禁用、目录标签、行内改定时、事实去重 |
| `tools/smoke.mjs` | 新增 state / stranded 两节 |
| `tools/client-smoke.mjs` | 新增 clamp / runlock / lostkind / dirfield / rowfacts / rowsech 六节 |
| `tools/retry-loop.mjs` | **新增** —— 冻结 bug 回归守卫 |
| `tools/check-clamp-guard.mjs` | **新增** —— 夹紧测试的变异校验 |
| `tools/check-row-guard.mjs` | **新增** —— 去重与行内改定时的变异校验 |
| `docs/report-0.6.0.md` | **新增** —— 本报告 |
| `CHANGELOG.md` / `README.md` | 中英文说明 |
| `package.json` | 0.6.0，`test` 并入 retry-loop，新增 `guard` 脚本 |
| `package.json` | 0.6.0，`test` 脚本并入 retry-loop |
