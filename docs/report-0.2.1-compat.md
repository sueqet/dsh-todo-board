# 0.2.1-rc.2 兼容性对照：`dsh-todo-board` 0.13.1

- 核查时间：2026-10-17
- 目标运行时：`dsh-desktop-runtime` **0.2.1-rc.1**，内部 `@deepseek-ai/*` 全部 **0.2.1-rc.2**，cordis **4.0.5**
- 插件版本：`dsh-todo-board` **0.13.1**
- 核查方式：`cordis_inspect`（Service / Event / Slots 三个 Provider，读**运行中**的真机注册表）+ 桌面端 `app.asar` 内 0.2.1-rc.2 源码逐处比对 + 本机 `node --check` / `tools/smoke.mjs` 实跑
- **全程只读**：本步未修改插件任何一行代码

> 上一版适配报告是 0.12.0 的（针对 0.2.0-rc.2）。本文件只记录 **0.2.0-rc.2 → 0.2.1-rc.2** 这一跳的增量结论，以及插件对它们的实际依赖。

---

## 一、结论（先看这里）

**1. 插件依赖的 host 服务，一个都没少。** 逐个核对了 `ctx.get(...)` / `ctx.inject([...])` 用到的 14 个服务键，全部在 0.2.1-rc.2 的运行中注册表里，签名也都在插件用到的那些方法上保持兼容。

**2. 插件依赖的 host 事件，两个都在，且语义未变。**

**3. 会话格式仍是 v4**（`SESSION_FORMAT_VERSION = 4`），0.11.2 的 v4 适配继续有效，**不需要新的会话格式适配**。

**4. 唯一需要动的是版本门**：插件声明 `>=0.1.7-rc.2`，语义上已覆盖 0.2.1-rc.2，**但从未针对 0.2.1 做过任何验证，也没有上界声明**。这是第 2 步要处理的事，不是代码 bug。

**5. 本次核查没有发现任何必须修改的代码不兼容点。**

⚠️ 这条结论建立在一个前提下：`targetAlive` 那处一度被我判成「`sessions.has()` 已被删除」，**那是我读错了** —— 该处的 `sessions` 是 `liveSessions()` 返回的 `Map`，`Map.prototype.has` 合法存在，与服务层 `ctx.sessions` 无关。已在 §四 留档，避免下次重复踩。

---

## 二、host 服务逐项核对

来源：`cordis_inspect_query(platform=host, provider=Service, method=listService)`

| 插件用到的键 | 插件调用点（`lib/index.js`） | 0.2.1-rc.2 实际状态 | 结论 |
| --- | --- | --- | --- |
| `agents` | `:1052` `agents.list()`、`:1862/:1893/:1947/:1960` `agents.get()` / `.create()` | `list(): Agent[]`、`get(id)`、`async create(options)` 全在 | ✅ 兼容 |
| `attachments` | `:1425` 取服务、`:3120` 取服务 | `saveImages`、`validateImage`、`imageLimits`、`readImage` 全在 | ✅ 兼容 |
| `llm` | `:1641` `llm.listModels(provider)`、`:1830` `llm.stream({...})` | `async listModels(provider): LlmModelInfo[]`、`stream(options): AsyncIterable<StreamChunk>` 全在 | ✅ 兼容 |
| `agentDefaultModel` | `:1671` 读默认模型 | `currentSelection(): ModelSelection` 在 | ✅ 兼容 |
| `sessionQuery` | `:1802` 取服务、`:1810` `query.readSurface(id)` | `readSurface(sessionId): Promise<SessionSurfaceSnapshot>` **仍在** | ✅ 兼容 |
| `agentPresets` | `:1870` 取服务、`resolve()` / `mount()` | `async resolve(id?)`、`async mount(ctx, id?)` 全在 | ✅ 兼容 |
| `systemPrompt` | `:2275` `ctx.inject(['systemPrompt'])` + `section(...)` | `section(section)` 在 | ✅ 兼容 |
| `skills` | `:2892` `ctx.inject(['skills'])`、`:2897` `skills.register(...)` | `register(skill)` 在 | ✅ 兼容 |
| `commands` | `:2913` `ctx.inject(['commands'])` | 服务在 | ✅ 兼容 |
| `tools` | `:2425` `ctx.inject(['tools'])` | `register(definition)`、`get()` 在 | ✅ 兼容 |
| `webServer` | `:3136/:3163` `ctx.inject(['webServer'])`、`hostCtx.webServer.register(...)` | `register(route)` 在 | ✅ 兼容 |
| `approval` | 审批门经 `dsh-tools` 间接消费 | `request()`、`overrideOf()` 均在 | ✅ 兼容 |
| `permissionPresets` | 不直接调用（auto-review 用） | `current()`、`set()`、`overrideOf` 兼容 | ✅ 兼容 |
| `sessions` | 仅 `plain()` 内的 `liveSessions()` Map，**非服务** | 服务在；插件未依赖其方法 | ✅ 兼容 |

### 需要特别记一笔的两处

**`sessionQuery.readSurface` 保住了。** 这是插件唯一一处「读别人的会话正文」的能力，用在 `newSession` 交接前自动生成摘要（`maybeWriteHandoffSummary`）。它不在最显眼的几个方法里，若被改名会**静默降级**成「没有摘要、照常交接」——正是 0.13.0 设计里刻意留的失败姿态，但当时没人验证过它在 0.2.1 上还在。**这次确认在。**

**`sessions` 服务在 0.2.1 里确实没有 `has()`。** 核查中一度据此判定插件 `:1132` 会抛 `TypeError`，复核后推翻：该行 `sessions` 是 `const sessions = live === undefined ? liveSessions() : live`（`:1099`）拿到的 **`Map`**，`Map.has` 合法。结论是**插件无此问题**，但这条值得记住 —— 服务名与局部变量重名，会让「看代码找不兼容」这件事产生假阳性。

---

## 三、host 事件核对

来源：`cordis_inspect_query(platform=host, provider=Event, method=listEvents)`

| 事件 | 插件用法 | 0.2.1-rc.2 签名 | 结论 |
| --- | --- | --- | --- |
| `agent/pre-step` | `:2154` waterfall，改注入的消息 | `'agent/pre-step'(this, payload:{agent,messages,turn,step,signal}, next): Promise<PreStepDecision>` | ✅ 未变 |
| `agent/turn-stopping` | `:2206` serial，回合结束接续队列 | `'agent/turn-stopping'(this, payload:{agent,turn,signal}): Promise<void> \| void` | ✅ 未变 |
| `tools/pre-execute` | `:2411` 审批门 | `'tools/pre-execute'(this, exec: ToolExecution, next): Promise<PreToolDecision>` | ✅ 未变 |
| `agent/status` | 未直接监听（靠 `agents.list()` 读 status） | `'agent/status'(this, payload:{agent,status})` | ✅ 无影响 |

---

## 四、会话格式

| 项 | 0.2.1-rc.2 实际值 | 证据 |
| --- | --- | --- |
| `SESSION_FORMAT_VERSION` | **4** | `dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:56` |
| 写入处 version 字面量 | `4` | 同文件 `:1069`、`:1819` |
| 导出符号 | `SESSION_FORMAT_VERSION` 仍在导出列表 | 同文件 `:2052` |

→ **0.11.2 起的 v4 适配（producer-owned source `plugin:dsh-todo-board`）继续有效，无需再改。**
→ `tools/check-session-format.mjs` 那套「把消息喂给真 `adoptSessionEvent()`」的守卫，对着 0.2.1 应当仍然有效（第 5 步真机验证时确认）。

---

## 五、client（浏览器半）核对

来源：`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)` + client Service 契约 + 内嵌 client bundle 比对

| 依赖 | 插件用法（`client/client.js`） | 0.2.1-rc.2 实际 | 结论 |
| --- | --- | --- | --- |
| `shell.overlay` slot | `:3243` `ctx.slots.inject('shell.overlay', ...)` | slot 仍在，`kind: list`、`scope: root`，注册参数仍是 `{id, order?, label?}` | ✅ 兼容 |
| `useSessions` store 形状 | `:1202` `s.byId` 遍历 | 快照仍是 `{ ids, byId, phase, projectionsBySession }`，**无 `current` 键** | ✅ 与 0.11.4 的修法一致 |
| `retainedBy.mainView` | `:1209` `((row.retainedBy ?? {}).mainView ?? 0) > 0` | `mainView` 仍被消费：`dsh-client-ui-layout/lib/client.js` 有 `mainView ?? 0`，workspace bundle 里 8 处、session bundle 里 2 处 | ✅ 兼容 |
| 样式 `data-plugin` 标记 | 0.13.1 已给每个 `<style>` 打 `data-plugin="dsh-todo-board"` | `claimStyles` 机制未变（`dsh-client-modules`） | ✅ 兼容 |

> 注：`SessionRetainInfo` 的 TS 声明里 `retainedBy` 是 `Partial<Record<SessionReferenceSource, number>>`，而 `SessionReferenceSourceMap` 只列了 `controllerOperation` / `gateway`——**声明面比运行时窄**。实际各 UI bundle 仍在读 `retainedBy.mainView`。插件按运行时行为写是对的，此处记录以备上游将来收紧。

---

## 六、与自动审查（auto-review）的关系

这一节只是把**已确认的事实**锚定下来，完整分析见第 6 步的报告。

| 事实 | 值 | 证据 |
| --- | --- | --- |
| 包 | `@deepseek-ai/dsh-experimental-auto-review` **0.2.1-rc.2** | `app.asar: dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/package.json` |
| 启用状态 | **已启用**（desktop profile） | `D:\DSH\dsh-home\profiles\desktop\cordis.yml:1245-1246`、`package.json` bundles 列表 |
| 挂载点 | `tools/pre-execute`，**`{ prepend: true }`** | `lib/index.js:488` |
| 生效条件 | `permissionPresets.current(session) === 'auto'` | `lib/index.js:464` |
| deny + `overrideOf === 'never'` | **直接 denied，不询问用户** | `lib/index.js:479` |
| deny + 其它策略 | 先 `next()` 走下游，**下游 allow 时才转成 `{kind:'ask'}`** | `lib/index.js:480-483` |
| auto 预设的 knob | `sandbox: danger-full-access`、`approval: ask` | `dsh-permission-presets/lib/index.js:58-61` |
| 插件审批门挂载 | `ctx.on('tools/pre-execute', ...)` **无 prepend** | `lib/index.js:2411` |

**执行顺序确定：auto-review（prepend）→ todo-board 审批门 → 工具本体。**

---

## 七、处置建议

| # | 项 | 是否需要改代码 | 归到哪一步 |
| --- | --- | --- | --- |
| 1 | host 服务 / 事件 / slot / store 形状 | **否** | 已在第 3、4 步的清单里标为「无需修改」 |
| 2 | 会话格式 v4 | **否** | 第 5 步真机确认 |
| 3 | 版本门没覆盖 0.2.1 的**验证**，也无上界 | **是**（只改 `package.json` + README） | 第 2 步 |
| 4 | auto-review 与审批门的顺序、静默拒绝路径 | **是**（见第 6 步定级） | 第 6、7 步 |

---

## 八、证据索引

| 用途 | 路径 |
| --- | --- |
| 真机服务目录（全量） | `cordis_inspect_query(host, Service, listService)`，落盘于 `%TEMP%\dsh-spill-*\...\c97af64183b7-cordis_inspect_query.txt` |
| 真机事件目录 | `cordis_inspect_query(host, Event, listEvents)` |
| 真机 slot 树 | `cordis_inspect_query(client, Slots, listSubTree)` → `92b28a95849e-...txt` |
| asar 读取器（本机可用） | `D:\DSH\plugin\_diag\read-asar-file.mjs`、`list-asar.mjs` |
| auto-review 源码 | `D:\DSH\plugin\_diag\ar-index.js`（自 asar 抽出） |
| 会话格式常量 | `D:\DSH\plugin\_diag\sess-index.js:56` |
| 权限预设定义 | `D:\DSH\plugin\_diag\pp-index.js:52-61` |
| client bundle（mainView） | `D:\DSH\plugin\_diag\cli-layout.js`、`cli-workspace.js`、`cli-session.js` |

### 复现方式

```bash
# 1. 真机服务/事件/slot：用 cordis_inspect_query（三个 Provider）
# 2. asar 内源码：
cd D:/DSH/plugin/_diag
node read-asar-file.mjs "D:/DSHDesktop/resources/app.asar" \
  "dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js" ar-index.js
node read-asar-file.mjs "D:/DSHDesktop/resources/app.asar" \
  "dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js" sess-index.js
grep -n "SESSION_FORMAT_VERSION" sess-index.js
# 3. 插件自身基线：
cd D:/DSH/plugin/dsh-todo-board
node --check lib/index.js && node --check client/client.js
node tools/smoke.mjs
```

> asar 头部是自定义 pickle 布局（`u32@0 = 4`，`u32@12 = json 长度`，数据区从 `16 + len` 起对齐到 4 字节）。**不要用官方 `asar` 包或常见片段读这个文件** —— 本次核查为此浪费了几轮，已固化成 `_diag/read-asar-file.mjs`。

---

## 九、真机验证结果（第 5 步）

上面的结论是**读代码 + 读注册表**得来的。这一步把它们放到**真的 0.2.1-rc.2 运行时**上跑一遍。

### 怎么跑：用桌面端自带的 Electron 直接加载 asar 内的运行时

`check-live.mjs` 与 `check-session-format.mjs` 默认指向 `C:/Users/XIAO/AppData/Roaming/npm/...` 下的全局 DSH —— 那是 **0.1.7-rc.2**，验不了 0.2.1。两个脚本都开了环境变量覆盖口，配合 `ELECTRON_RUN_AS_NODE=1` 可以**指向 asar 内部**，不需要把那 400MB 的 `dsh/node_modules` 解出来：

```bash
cd D:/DSH/plugin/dsh-todo-board

# 1) host 半：真 cordis / 真 dsh-tools / 真 ToolRuntime / 真审批门 / 真围栏
DSHTB_CORDIS="file:///D:/DSHDesktop/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js" \
DSHTB_TOOLS="file:///D:/DSHDesktop/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js" \
ELECTRON_RUN_AS_NODE=1 "D:/DSHDesktop/DeepSeek Harness.exe" tools/check-live.mjs

# 2) 会话格式：把四条注入路径喂给真的 adoptSessionEvent()
DSHTB_SESSION="file:///D:/DSHDesktop/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js" \
ELECTRON_RUN_AS_NODE=1 "D:/DSHDesktop/DeepSeek Harness.exe" tools/check-session-format.mjs
```

### 结果

| 套件 | 运行时 | 结果 |
| --- | --- | --- |
| `node --check lib/index.js` / `client/client.js` | — | ✅ |
| `tools/smoke.mjs` | 桩 | ✅ 13 段全绿 |
| `tools/client-smoke.mjs` | 桩 | ✅ 全绿（含 BUILD 与版本号一致） |
| `tools/retry-loop.mjs` | 桩 | ✅ |
| `tools/check-http.mjs` | 真 node:http | ✅ |
| `tools/check-fence-parity.mjs` | 真 harness | ✅ 72 条对照 |
| `tools/check-template-parity.mjs` | — | ✅ 17 行逐字一致 |
| **`tools/check-live.mjs`** | **真 0.2.1-rc.2（cordis 4.0.5 / dsh-tools 0.2.1-rc.2）** | ✅ 8 项全绿 |
| **`tools/check-session-format.mjs`** | **真 0.2.1-rc.2（dsh-session 0.2.1-rc.2）** | ✅ 4 条注入路径 + 1 条反例 |
| `npm run guard` | 变异体 | ✅ clamp 3 + row 44 + host 18 = **65 个变异体全部被抓**，源码逐字节还原 |

`check-live` 在真 0.2.1 上确认的具体项：

- `live` — 插件能在真 cordis 上激活
- `live` — **晚到的服务仍能注册**（0.9.1 那个 `ctx.inject` 竞态没有回退）
- `live-plan` — skill 与 command 在插件行**之后**提供时仍注册成功
- `live-schema` — 工具参数通过 harness 的真实 JSON Schema 校验（含嵌套 `items`）
- `live-log` — 真实 `LoggerService` 的 levels 门控符合预期
- `live-gate` — 读放行、写要 ask、deny / grant 都被尊重
- `live-fence` — 路由围栏在真注入路由上生效
- `live-conn` — 路由借的是 harness 的 `connection` 门，不是复刻

`check-session-format` 在真 0.2.1 上确认：`newSession/followup`、`resume/followup`（两条）、`resume/steer` 共 4 条注入消息全部通过 `adoptSessionEvent()`；旧写法（裸字符串 `content`）仍被拒绝 —— 守卫没有变空。

> **一处环境注意**：Electron 的 `ELECTRON_RUN_AS_NODE` 模式下，`import()` 可以穿过 asar 读文件并解析其中的裸包名依赖，所以**不必**把 `dsh/node_modules` 解压到磁盘。这条路子在 0.12.0 的 CHANGELOG 里已有先例，本次沿用。
