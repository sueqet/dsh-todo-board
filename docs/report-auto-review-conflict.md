# 自动审查（auto-review）与 TODO 板：冲突分析

- 分析时间：2026-10-17
- 目标运行时：`dsh-desktop-runtime` 0.2.1-rc.1 / `@deepseek-ai/*` **0.2.1-rc.2**
- 涉及两方：
  - `@deepseek-ai/dsh-experimental-auto-review` **0.2.1-rc.2**（"自动审查模式"）
  - `dsh-todo-board` **0.13.2**
- 方法：读 asar 内双方源码 + 读 `dsh-tools` 的 waterfall 消费点 + 在真 0.2.1 运行时上实跑 `tools/check-live.mjs`
- 每条结论都标注 **【已实测】** 或 **【读代码】**，不混着说

---

## 一、结论（先看这里）

**1. 最要紧的一条：用户开 Auto 预设时，TODO 板的自动续跑链会断。** 【读代码，机理确定】
原因不是「弹两次窗」，而是 **`done` 这一动作会先被 LLM 审查一次**：审查判 medium 且判定为拒绝时，在 `approval.overrideOf === 'never'` 的会话里**直接 deny、不询问用户**，`done` 失败 → 「做完一条勾掉、再取下一条」的循环当场停住。

**2. 我之前说的「会连弹两次审批框」是错的，这里更正。** 【已实测】
`tools/pre-execute` 是**一条** waterfall，`dsh-tools` 只对**最终**裁决调用一次 `serviceAsk()`。两个监听器是同一条链上的两节，不是两道闸门。所以不会出现「先问一次、再问一次」。

**3. 但确实存在「两层含义不同」的审批，只是形式不是双弹窗。** 【读代码】
- auto-review 判 **deny** 且策略不是 `never` 时：它先 `next()` 把裁决交给下游（TODO 板会给 `ask`），下游是 `ask` 而非 `allow`，于是 auto-review **原样返回下游的 `ask`** —— 用户看到的是 **TODO 板措辞**的审批框，**auto-review 的拒绝理由不会出现**。
- 只有在「下游也允许」时，auto-review 才会把自己的 deny 转成 `ask` 抛出。

**4. `note` / `title` 文本会进入审查模型的 prompt。** 【读代码】
它们被序列化进 `PENDING_ACTION.arguments`。这是一条**提示注入面**，但影响被 auto-review 自身的协议**大幅削薄**（见 §五）。

**5. 插件侧能做的很有限，且**不该**用「绕过审查」的方式做。** 【读代码】
冲突的根源在评审发生在**注册表层**，插件无法也不应躲开它。可行的应对是**降低被误判的概率** + **把限制写进文档**，而不是改工具名/拆动作去骗过审查。

---

## 二、两方的挂载点与执行顺序

### auto-review 【读代码】

`dsh-experimental-auto-review/lib/index.js`：

```js
// :461-488
yield ctx.on("tools/pre-execute", async (exec, next) => {
  const agent = exec.agent;
  if (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();
  if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();   // :464
  if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };
  ...
  const review = await classifyRisk(...)                                         // :469 → LLM 审查
  if (!review.ok) return failed(exec, review.error);
  const { decision } = review;
  if (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never")
    return denied(exec, decision.reason);                                        // :479 静默拒绝
  const downstream = await next();                                               // :480 走下游
  if (decision.decision === "allow" || downstream.kind !== "allow") return downstream;  // :482
  return askUser(exec, decision.reason);                                          // :483
}, { prepend: true });                                                            // :488 排在最前
```

要点：
- **只在 `permissionPresets.current(session) === 'auto'` 时介入**（`:464`），其它预设它直接放行。
- **`prepend: true`**（`:488`）→ 排在 TODO 板的审批门**之前**。
- 审查用的模型路由取自**当前会话的 request-header**（`snapshotAutoReview` → `header.config.provider/model`，`:220`），不是另配的模型。

### TODO 板 【读代码】

`dsh-todo-board/lib/index.js`：

```js
// :2411-2421
ctx.on('tools/pre-execute', (exec, next) => {
  if (exec === undefined || exec === null || exec.name !== TOOL_NAME) return next()
  const action = ...
  if (APPROVAL_FREE_ACTIONS.indexOf(action) >= 0) return next()   // list / done / reopen
  return { kind: 'ask', reason: 'AI 要修改待办板：' + approvalDetail(action, input) }
})
```

`APPROVAL_FREE_ACTIONS = ['list', 'done', 'reopen']`（`:2342`）。

### 顺序

```
auto-review (prepend)  →  todo-board 审批门  →  工具本体
```

### 下游只问一次 【已实测】

`dsh-tools/lib/index.js:3321-3323`：

```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, ... };
```

`serviceAsk`（`:3535`）只发一次 `approval.request(...)`。

→ **「双弹窗」不成立**，此处更正 §一.2。

---

## 三、判定矩阵：谁在什么时候被拦

「允许」= 工具本体照常执行。

| 预设 | TODO 板动作 | auto-review 判定 | 下游（TODO 板） | 最终结果 | 用户看到 |
| --- | --- | --- | --- | --- | --- |
| 非 `auto` | 任意 | 不介入 | — | 按 TODO 板原逻辑 | 原样 |
| `auto` | `list` | allow | `next()` → allow | ✅ 执行 | 无 |
| `auto` | `done` / `reopen` | **allow** | 放行（免审批） | ✅ 执行 | 无 |
| `auto` | `done` / `reopen` | **deny** + 策略 `never` | — | ⛔ **拒绝，不询问** | **无**（链断，静默） |
| `auto` | `done` / `reopen` | **deny** + 策略 `ask` | — | ⚠️ ask | **auto-review 的拒绝理由** |
| `auto` | `add`/`update`/… | allow | `ask` | ⚠️ ask | 仅 TODO 板措辞 |
| `auto` | `add`/`update`/… | deny + `never` | — | ⛔ deny | 无 |
| `auto` | `add`/`update`/… | deny + `ask` | `ask`（非 allow） | ⚠️ ask | **仅 TODO 板措辞**（`:482` 原样返回下游） |

**这里有一处不对称，值得单独指出【读代码】：**

同样是 deny，`add` 这类**本就要问**的动作最后会走到审批框，而 `done`/`reopen` **本就免审批**，所以 auto-review 的 deny 在 `never` 策略下**无处可问**，只能硬拒。

**这正是冲突的机制**：TODO 板刻意让 `done` 免审批，理由写在源码注释里（`:2332-2337`）——「左勾是自动续跑循环的燃料，在 `danger-full-access`（策略 `never`）下每次 ask 都会被拒，链子当场断」。这个推理在**没有 auto-review** 时成立；**有了 auto-review**，`done` 虽然不走审批，却要走审查，于是同一类风险以另一种形式回来了。

---

## 四、影响分级

| # | 影响 | 严重度 | 依据 |
| --- | --- | --- | --- |
| 1 | Auto 预设 + `never` 下，`done` 被判 deny → **自动续跑链静默中断** | **高** | §三矩阵第 4 行；`ar-index.js:479` |
| 2 | 用户看不到「为什么停」：面板只显示行仍在「已派发」，日志里也没有明确归因 | **高** | 拒绝发生在工具层，插件没有收到任何回调；`failed()`/`denied()` 只进模型上下文 |
| 3 | 每次 `todo_board` 调用多一次 LLM 往返（含 `list`） | 中 | `:469` 对所有调用都评审；`list` 是高频轮询动作 |
| 4 | `note`/`title` 文本进入评审 prompt | 中 | §五 |
| 5 | `done` 被判 deny 但策略是 `ask` 时，用户要为本不该打断的动作点一次确认 | 中 | §三矩阵第 5 行 |
| 6 | 审批框文案可能不完整：auto-review 的拒绝理由在「下游也 ask」时**丢失** | 低 | `:482` |
| 7 | 「双弹窗」——**不存在** | — | 已证伪，见 §一.2 |

### 严重度为「高」的那条的准确表述

> **不是**「Auto 模式让 TODO 板坏掉」，而是：**Auto 模式把「`done` 免审批」这个安全判断重新交给了 LLM，而插件既不知道、也无从感知。**

---

## 五、`note` / `title` 的注入面评估

**事实【读代码】：** `PENDING_ACTION.arguments` 里就是模型给的原始参数（`ar-index.js:310` → `nativeAction` → `exec.arguments`），`todo_board` 的 `title` / `note` / `items[].note` 都在其中，会以 JSON 形式进入审查模型的 user message（`reviewUserText`，`:321-332`）。

**为什么风险被削薄**【读代码】：

1. **审查模型不执行任何东西**，只输出一个 JSON：`{risk, decision}` 或 `{risk, decision, reason}`。协议由 `parseDecision`（`:352`）**严格校验**：成员数、取值组合、`low+deny`/`high+allow` 一律拒绝。
2. **判 deny 时 reason 只会回显给用户**（`askUser` 的 `displayReason`），**不会**成为任何指令。
3. 即便评审被说服放行，它放行的也只是**这一次工具调用**，仍是 `todo_board` 的写操作本身 —— 审批门的语义没有被绕过，只是被替换。
4. 输入侧还有 `topLevelMemberCount`（`:334`）防止重复 JSON 成员。

**残余风险**：
- 注入可以让审查模型**误判风险等级**（把一次 medium 的写说成 low），从而在 `never` 策略下**减少**一次拒绝。但注意：在 `never` 策略下 `todo_board` 的写本来也**不会**弹窗（TODO 板返回 `ask`，auto-review 判 allow 后仍返回下游 `ask`，而 `never` 下 `ask` 会被拒）——所以「骗过审查」并不能凭空获得一次未被授权的写入。
- 当 TODO 板从 `add --mode=resume` 拿到的 `note` 被派发时，`note` 还会进入**执行**模型的上下文。这是**既有设计**（note 本来就是上下文），与 auto-review 无关，但两处叠加意味着 `note` 同时影响**谁来审**和**谁来做**。值得在文档里写明。

**结论**：注入面存在但**不可用于提权**，只能用于「让审查更宽松」或「让审查误判」。真正的护栏仍是 `todo_board` 自己的审批门 + `never` 策略对 `ask` 的一律拒绝。

---

## 六、插件侧能做什么、不能做什么

### 不能做的

| 想法 | 为什么不行 |
| --- | --- |
| 改工具名 / 拆成两个工具躲开审查 | 审查按 `exec.name` 之外还看 `exec.parent` 与 schema，且**审查的是效果不是名字**；改名只是让白名单失效，属于**削弱安全边界** |
| 在 `tools/pre-execute` 里 `unshift` 把审批门插到 auto-review 之前 | cordis 的 `prepend` 决定了先后，且**争抢顺序本身就是错的**：审查是安全层，不该被业务插件越过 |
| 让 `done` 不进审查 | 插件只能控制自己的返回值，控制不了别人对同一 waterfall 的介入 |
| 直接改 `dsh-experimental-auto-review` | 它是官方包，在 profile 的 bundles 里；改了会被下一次升级覆盖，也不是本插件的范围 |

### 可以做的

| 做法 | 价值 | 归到哪 |
| --- | --- | --- |
| **把限制写进 README**（Auto 预设下 `done` 可能被拦、链可能断） | 高——用户至少知道去哪看 | 第 7 步 |
| **让 `done` 的语义对审查更「无害」**：`done` 只翻一个布尔、不删除、不改内容 | 中——审查模型看的是**效果**，越明确的「低风险效果」越不容易被判 medium | 第 7 步 |
| **在工具描述里明确写清 `done` 只是标记完成** | 中——描述会进 `header.tools`，审查模型**能看到**（`nativeAction` → `schema.description`，`ar-index.js:181-193`） | 第 7 步 |
| **补一条回归测试**：断言 `done` 的审批豁免仍在，且工具描述包含「仅标记、不删除」的措辞 | 中——防止将来有人为了适配审查而悄悄削弱豁免 | 第 7 步 |
| 面板上把「已派发但链断了」标出来 | 低——需要知道审查结果，插件拿不到 | 不做（记录为上游限制） |

---

## 七、给用户的一句话

> 开着**自动审查模式**时，TODO 板的「干完自动接下一件」可能在中途停住，而且**不报错**。这不是插件坏了，是审查层把 `done` 判成了需要人确认的动作，而 `done` 在你的设计里本来就不问人。**要么这条链在 Auto 模式下改用 `resume` 手动推进，要么把会话切回非 Auto 预设再让它跑长任务。**

### 七点一、三个预设的实测结论（2026-10-17 补）

`workspace-write` 是推荐档。三者的差别只有「沙箱 + 审批」两个旋钮：

| 预设 | `(sandbox, approval)` | `done` 推动续跑链 | 写操作（`add`/`update`/`dispatch`） |
| --- | --- | --- | --- |
| **`workspace-write`** | `(workspace-write, ask)` | ✅ 正常 | ✅ 弹一次确认后执行 |
| `danger-full-access` | `(danger-full-access, never)` | ✅ 正常（无审查） | ⛔ **全部失败** |
| `auto`（自动审查） | `(danger-full-access, ask)` | ⚠️ 可能静默中断 | ✅ 弹一次确认后执行 |

**`danger-full-access` 那一格是实测过的，不是推断。** 把会话切到 `never` 后调用 `todo_board action=add`，返回：

```
Error: the user rejected tool "todo_board"
```

全程没有任何弹窗。`dsh-user-approval` 的 `decide()` 第一句就是 `if (effectivePolicy(session) === 'never') return 'rejected'`——**`never` 的语义是「不问，直接拒」，不是「一律放行」**；`dsh-tools` 的 `serviceAsk()` 再把 `rejected` 翻成 `deny`，工具调用失败。那句 "the user rejected" 是标准措辞，**并不是用户真的点了拒绝**。

由此得出一条容易踩反的结论：

> **「完全权限」放开的是「能碰什么」（sandbox），不是「不用问」（approval）。审批档 `never` 恰恰要求每一条需要确认的动作都被静默杀掉。** 所以对一个**依赖审批通道做写操作**的插件来说，`danger-full-access` 是三个档里**最差**的一个。

**为什么不存在「自动审查 + never」的组合**：`auto-review` 的第一句是 `if (permissionPresets.current(session) !== AUTO_PRESET) return next();`，而 `AUTO_PRESET_SPEC` 固定是 `{ sandbox: 'danger-full-access', approval: 'ask' }`（`dsh-permission-presets/lib/index.js:58-61`）。预设是二元组，`ask` 是 `auto` 的一部分——想要审查就必然 `ask`，想要 `never` 就必然没有审查。

---

## 八、证据索引

| 结论 | 证据位置 |
| --- | --- |
| auto-review 挂 `pre-execute` 且 `prepend` | `_diag/ar-index.js:461`、`:488` |
| 仅 `auto` 预设生效 | `_diag/ar-index.js:464` |
| deny + `never` 直接拒绝 | `_diag/ar-index.js:479` |
| deny + 非 `never` 先把下游结果带回 | `_diag/ar-index.js:482` |
| 审查只输出受校验的 JSON | `_diag/ar-index.js:352-374` |
| 审查输入含调用参数 | `_diag/ar-index.js:310`、`:321-332` |
| TODO 板豁免 `list/done/reopen` | `dsh-todo-board/lib/index.js:2342`、`:2411-2421` |
| 豁免的理由原文 | `dsh-todo-board/lib/index.js:2332-2337` |
| 单次 waterfall、单次 ask | `_diag/rt021/dsh-tools/lib/index.js:3321-3323`、`:3535` |
| auto 预设 knob | `_diag/pp-index.js:52`、`:58-61` |
| 本机已启用 | `D:\DSH\dsh-home\profiles\desktop\cordis.yml:1245-1246` |
