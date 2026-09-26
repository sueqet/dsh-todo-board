# 方案：后台日志（面板内切换日志页）

> 状态：**已实施（v0.9.0）**。本文保留为设计与依据记录；实施结果与偏差见文末 §5。
> 确认过的 UX 形态（用户 2026-09-25）：**不用 DSH 设置栏**；在 TODO 面板标题栏加一个小按钮，
> 点击把面板从 TODO 视图切到**日志视图**（同一个浮窗内切换），平时不暴露给用户，
> 出错时能给开发者调试线索。

---

## 0. 实施结果摘要（v0.9.0）

用户拍板：**默认只记本插件**（`levels: { 'dsh-todo-board': 3, default: 0 }`）。

| 本文的提案 | 实施结果 |
| --- | --- |
| §3.1 自注册 exporter + 自写 printf 格式化器 | ✅ 照做，实测 `levels` 门控确实生效（自己的 debug 进得来，兄弟插件 debug 被挡） |
| §3.2 脱敏为承重结构，每行都过 | ✅ 照做（规则集见下），并由 smoke 的 `redact` 组钉住 |
| §3.3 落盘 `log.ndjson` + 过半裁剪 + 写失败自停 | ✅ 照做 |
| §3.4 扩展现有 2.5s 轮询、不引入 SSE | ✅ 照做；日志**只在视图打开时**才随轮询返回 |
| §3.5 补齐失败路径 | ✅ 照做（见 §5.2） |
| §4 待定项 | ✅ 已定，见 §5.1 |

**实施中发现、本文原稿未覆盖的一条**（见 §5.3）：这两条路由**不在 DSH 的 `/api` 信任围栏内**，
在补日志之前必须先补上围栏 —— 否则日志会挂在一条无鉴权、可被跨站读取的路由上。

---

## 1. 先说三个必须知道的坑（都已实测，不是推测）

这三条决定了方案长什么样，所以放在最前面。

### 1.1 内置环形缓冲**丢掉 warn 和 debug**，不能当日志源

`ctx.logger.buffer` 看起来是个现成的 1000 条缓冲，但它是**残的**。

`cordis/src/logger.ts:213-221` 注册这个 exporter 时**没有给 `levels`**：

```js
self.exporter({
  colors: 3,
  export: (message) => { self.buffer.push(message); /* ... */ },
})
```

而门控是 `logger.ts:155`：

```js
const targetLevel = exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? LoggerLevel.INFO
if (targetLevel < level) continue
```

级别数值是 `error=0 info=1 warn=2 debug=3`。没给 `levels` → 默认 `INFO=1`，
于是 `warn(2)` 和 `debug(3)` 都被 `1 < 2`、`1 < 3` 挡掉。

实测（`error` / `info` / `warn` / `debug` 各记一条）：

```
bufferTypes: ["error", "info"]      ← warn 和 debug 不在里面
```

**结论：缓冲里一条告警都没有，做调试功能毫无价值。必须自己注册 exporter。**

附带一条：溢出时 `buffer` 是**整个重新赋值**的（`self.buffer = self.buffer.slice(...)`），
所以任何缓存下来的引用立刻过期 —— 要读就每次 `ctx.logger.buffer.slice()`。

### 1.2 `inject: ['logger']` 会让插件行**死锁**（绝不能写）

`logger` 不是注册服务（`ctx.get('logger') === undefined`，实测），它是 cordis 给每个 Context
装的自身属性。把它写进 `inject` 会让 fiber 永远等一个不会来的服务，**插件根本不执行**。
直接 `ctx.logger.xxx()` 用即可。

### 1.3 `ctx.logger.exporter()` 的 disposer 在**两个 exporter 时是坏的**

`logger.ts:232-237` 的 disposer 引用的是 `this._snExporter`（**引用**，不是当时的值）：

```js
exporter(exporter) { return this.ctx.effect(() => {
  this.exporters.set(++this._snExporter, exporter)
  return () => this.exporters.delete(this._snExporter)   // ← 读的是最新值
}, '...') }
```

实测：注册 e1、再注册 e2，然后 dispose e1 →

```
sizeAfterTwo: 3
sizeAfterDisposingFirst: 2
whoReceivedAfterDisposingFirst: ["e1:after-dispose"]   ← e2 被误删，e1 留下了
```

**结论：本插件只注册一个 exporter，并且永远不靠这个 disposer 去摘它** ——
靠 fiber 卸载。**那条路径实测是正确的**：插件行被卸载时 `exporters.size` 正常下降，
effect 的标签是 `ctx.logger.exporter()`（可用 `ctx.fiber.getEffects()` 看到）。
所以"只注册一个 + 靠卸载回收"是安全的做法，不是无奈之举。

---

### 1.4 `Message.args` 是**未格式化的原始参数**，而且没有现成格式化器可用

这一条推翻了本文档的初稿（初稿写的是"用 cordis 自己的 `Logger.format`"）。实测：

```
root.logger('t').warn('code=%s n=%d obj=%o', 'ABC', 42, { k: 1 })
捕获到的 message.args: ["code=%s n=%d obj=%o", "ABC", 42, {k:1}]   ← 占位符原样在
```

`%s` / `%d` / `%o` **不会被解析**。而 `Logger.format` 是 `Logger` 类的**静态方法**，
不是 `LoggerService` 的成员，插件既不能 import cordis，也拿不到它：

```
loggerOwnKeys: ["length","name","prototype","bufferSize","buffer","ctx",
                "_snMessage","_snExporter","exporters"]     ← 没有 format
serviceHasFormat: false
```

**结论：我们要自己带一个小的 printf 格式化器**（`%s %d %i %f %o %O %c %C %%`，
约 15 行）。这反而更好：零依赖、行为自己定。但**必须做**，否则
`logger.warn('failed for %s', id)` 在日志里就是一条带 `%s` 的废话，
而 `logger.warn(error)` 会变成 `[object Object]`（首参是 Error 时要取 `stack`）。

---

## 2. 一个关键能力，也是本方案最大的设计选择

exporter 的视野是**整个进程**，不是只有自己。我原本以为会有作用域限制，实测推翻了：

```
collector 是插件 A 注册的 exporter，它收到了：
  noisy-named:warn        ← 兄弟插件
  inner-named:error       ← 孙插件
  root-direct:warn        ← 根上下文直接打的
conclusion: exporter is PROCESS-WIDE: a plugin can capture every logger
```

（`logger.ts:154` 的 `for (const exporter of this.service.exporters.values())` 里，
`this.service` 是**共享的** LoggerService 实例。已验证 `exporters.size` 在插件句柄和
根句柄上读数一致。全进程只有一个 `LoggerService`，`exporters` 是它上面一个扁平的 `Map`。）

### 2.1 但"记全进程"必须先解决泄密 —— 我最初的风险判断是**偏乐观的**

我最初抽查了 `dsh-credentials*` / `dsh-llm*`，没发现把密钥传进 logger 的调用，
据此认为"记全进程可行"。**这个审计不完整**：泄密不在**直接记录**，
而在 **Config 校验失败**这条路径上 —— 校验错误消息会**带着原始值**进日志。
我自己复现了两条：

**泄密 1（已复现）**：`dsh-mcp-client` 的 Config 是 `z.union([stdio, streamable-http])`，
union 失败时会把**整个配置对象** JSON 出来：

```
expected {...} | {...} but got
{"transport":"bogus","serverName":"github",
 "headers":{"Authorization":"Bearer sk-live-REALKEY0123456789abcdef"},
 "env":{"GH_TOKEN":"sk-live-REALKEY0123456789abcdef"}}
```

即 `cordis.yml` 里 `transport` 少打一个字母，**所有 MCP 密钥和 Authorization 头
就进了日志**。

**泄密 2（已复现）**：schemastery 校验失败时把**原始值**塞进消息。
整个 section 被写成一个裸标量（手改 YAML 时忘了写 `apiKey:` 这个键，是很现实的笔误）：

```
expected object but got sk-live-REALKEY0123456789abcdef
```

（顺带一个**反例**，说明不能一概而论：字段类型写错时消息指向**出错字段**、
对象只打印成 `[object Object]`，`$.retries expected number but got not-a-number`
并不泄露同一 section 里另一个字段的值。所以风险是**具体的、可枚举的**，不是"日志都危险"。）

**另外**：`role('secret')` 只影响 `dsh-settings` 给 **UI 传输**的脱敏，
对 logger 输出**毫无作用** —— 不能指望它。

**还有**：`Message.args` 里 `Error` 的**自有可枚举属性**会原样带出，
而 cordis 会把 `error.cause` **再记一条**、`AggregateError` 的每个成员**各记一条** ——
一个"包装错误"能变成好几条带细节的记录。

### 2.2 于是设计选择变成这样

| | A. 只记本插件（**推荐默认**） | B. 记全进程 |
| --- | --- | --- |
| 级别配置 | `levels: { 'dsh-todo-board': 3, default: 0 }` | `levels: { default: 3 }` |
| 内容 | 本插件 debug 全开；别的插件**只收 error** | 所有插件所有级别 |
| 泄密面 | 我们自己的代码，可控 | **包含上面两条已复现的泄密路径** |
| 调试价值 | 能定位**本插件**的派发失败/建会话失败 | 还能看到跨插件因果（"会话为什么没起来"） |

**注意 `default: 0` 不是安全区**：它仍然收别的插件的 `error`，
而泄密 1 正是从 error 路径出来的。所以：

> **无论选 A 还是 B，落盘前都必须过脱敏层。** 区别只是量级：
> A 默认只脱自己的（面小），B 要脱全进程的。
> 若选 B，建议**默认不开**、由用户在日志视图里显式打开，并明确提示"会包含其他插件的日志"。
> 用户原话要求"平时不能在面板中暴露给用户"，B 默认关闭才符合这条。

---

## 3. 方案

### 3.1 采集

在 host 半边注册**一个** exporter：

```js
ctx.logger.exporter({
  // 打开 debug：exporter.levels 优先级高于 logger 自身级别
  levels: { default: 3 },
  export: (message) => record(message),
})
```

`record(message)` 做四件事：

1. **归属**：从 `message.fiber.deref()?.runtime?.name` 取来源包名；
   从 `message.name` 取 logger 名（本插件在 `cordis.patch.yml` 里注册为 `dsh-todo-board`，
   插件又 `export const name = 'dsh-todo-board'`，所以自身行可稳定识别）。
2. **格式化**：**自己写一个小 printf 格式化器**（见 §1.4 —— `Message.args` 是原始参数，
   而 cordis 的 `Logger.format` 是 `Logger` 类的静态方法，插件拿不到）。
   必须处理三种情况：
   - `args[0] instanceof Error` → 取 `.stack`（否则变 `[object Object]`）；
   - `%s %d %i %f %o %O %c %C %%` 占位符；
   - 余下的对象参数逐个 `JSON.stringify`。
   每个参数都要**限长**，并且在拼完之后**整条再过一次脱敏**。
3. **脱敏**：**承重结构，每一行都要过**，见 §3.2。
4. **写两处**：内存环（给面板即时读）+ 追加落盘（跨重启）。

### 3.2 脱敏（**承重结构**，不是锦上添花）

> **本节初稿的结论是错的，已更正。** 初稿写的是"抽查了凭据相关包，没发现密钥进日志，
> 所以全进程模式风险可控"。错在**只看了 logger 的调用点**，而密钥是从
> **`Error.message` 里进来的** —— 调用点本身长得很干净（`logger.warn(error)`）。
> 下面两条都是我**自己复现**过的，不是推测。

#### 已复现的泄密 1：`dsh-mcp-client` 会把整个配置（含 `env` 与 `headers`）打出来

它的 Config 是全树**唯一**的顶层 `z.union`；union 失败时 schemastery 把收到的值
整个 `JSON.stringify` 进消息：

```
Config({ transport:'bogus', serverName:'github',
         headers:{ Authorization:'Bearer sk-live-REALKEY0123456789abcdef' },
         env:{ GH_TOKEN:'sk-live-REALKEY0123456789abcdef' } })
→ 消息里包含 Authorization 密钥：true
→ 消息里包含 env 令牌：true
```

**这台机器上就有实例**：`profiles/web/cordis.patch.yml` 里有两个 `dsh-mcp-client` 行，
带着真实的 `CONTEXT7_API_KEY: ctx7sk-…`。**`transport` 少打一个字母就够了。**

到达路径：`cordis/lib/index.js:1354` → `:1359 ctx.logger.error(reason)`
（单个 Error 参数、无 cause → **原样导出**），并且 `cordis-plugin-loader` 的包装消息
会把这个 dump **再嵌一次**。

#### 已复现的泄密 2：Config 里任何标量密钥在校验失败时会回显

```
Config({ apiKey: [SECRET] })        → "$.apiKey expected string but got sk-live-REALKEY…"
Config(SECRET)  （整个 section 写成裸标量）→ "expected object but got sk-live-REALKEY…"
Config({ maxUses:'ten', apiKey:[SECRET] }) → 同样回显 apiKey 的值
```

第一条尤其现实：**手改 `settings.yaml` 时把 `apiKey` 写成了列表**（多写个 `-`）。
到达路径是普通的设置加载：`dsh-settings/lib/index.js:490-495`
的 `logger.warn("settings: keeping last good …")` 之后紧跟 `logger.warn(error)`。

**`role('secret')` 救不了** —— 它只驱动 `dsh-settings` 给 **UI 传输**的脱敏
（`describe({redactSecrets:true})`），对 logger 输出**毫无作用**。
全树唯一的真实 `role('secret')` 字段就是 `dsh-web-search-deepseek` 的 `apiKey`。

#### 已复现的泄密 3：`cause` 是**第二条投递通道**，包装错误会变成两条记录

cordis 在 `logger.ts:142-150` 会把 `args[0].cause` **单独再记一条**，
而**非 Error 的 cause（普通对象）原样导出**：

```
logger.error(new Error('wrapper failed', { cause: { apiKey: SECRET } }))
→ 收到 2 条记录：
   [{apiKey:"sk-live-…"}]        ← cause 自己那条，密钥裸奔
   ["wrapper failed"]
```

另外 `Error` 的**自有可枚举属性**也会带出去：

```
err.request = { headers:{ authorization:'Bearer '+SECRET } }
logger.error(err)   → 记录里包含密钥：true
```

#### 一个反例，说明风险是具体的而不是笼统的

字段类型写错时，消息**指向出错字段**、对象只打成 `[object Object]`，
**不**泄露同 section 里别的值：

```
Probe({ apiKey: SECRET, retries:'not-a-number' })
→ "$.retries expected number but got not-a-number"     ← 不含 apiKey 的值
```

所以这不是"日志都危险"，而是**三条可枚举的具体路径**。

#### 已复现的泄密 4：`credentialRef()` 会把它的**参数原样回显**（前缀规则挡不住）

`dsh-credentials/lib/index.js:22` 校验失败时把值打进消息：

```
credentialRef('sk-live-REALKEY…')      → 'credential ref "sk-live-REALKEY…" must match /^[A-Za-z_][A-Za-z0-9_]*$/'
credentialRef('ctx7sk-297eea2b-…')     → 'credential ref "ctx7sk-297eea2b-…" must match /^[A-Za-z_][A-Za-z0-9_]*$/'
credentialRef('CONTEXT7_API_KEY')      → ACCEPTED（合法 ref 名照常通过）
```

触发场景很普通：用户把**真的密钥**填进了 `apiKeyEnv`（那本该填一个引用名）。
而且 **schema 拦不住** —— `dsh-llm-pi-ai` 的 `apiKeyEnv: z.string().role('credential-ref')`
里 `z.string()` 接受任意字符串，`role()` 只写 `schema.meta.role`、**不做任何校验**；
只有 `credentialRef` 会拒绝，而它顺手把值打了出来。

**这条对脱敏设计有一个具体要求**：它回显的是**用户粘进去的任意字符串**，
**不保证以 `sk-` 开头**（上面第二条就是 `ctx7sk-` 开头）。
所以脱敏**不能只靠前缀匹配**，必须针对这个形状单独加规则
（匹配 `credential ref "…" must match` 这类"值出现在引号里"的位置），
否则这条会漏网。

到达路径已核对：`dsh-llm-pi-ai/lib/index.js:1105` → `resolveProfiles` 抛出
→ `:2663`/`:2588` → `onChange`（`:2670`）→ `catch`（`:2672`）→ `:2674 ctx.logger.error(error)`
（单 Error 参数、无 cause → 原样导出）。
`dsh-llm-deepseek` 形状相同（`:1992` → `:2033`）。
**本机是潜伏而非已发生**：`settings.yaml` 里的名字都是合法 ref 语法，所以今天不触发。
它的价值在于**证明脱敏层是承重的** —— 这是一个普通用户的普通笔误，
输出是一段**没有任何可匹配前缀**的裸密钥。

#### 一个精确性修正：泄密是**仅限标量**的，别over-claim

初稿容易读成"schemastery 会把什么都打出来"。**不是。**
只有 `union` / `intersect` 这两个分支调 `JSON.stringify`；
其他分支用 `${data}`（即 `String(data)`），对象会变成 `"[object Object]"`。实测：

```
Scalar({ apiKey: [SECRET] })     → "$.apiKey expected string but got sk-live-REALKEY…"   ← 泄露
Scalar({ apiKey: { v: SECRET } })→ "$.apiKey expected string but got [object Object]"    ← 不泄露
Scalar({ apiKey: 12345 })        → "$.apiKey expected string but got 12345"              ← 不泄露
Union({ headers:{Authorization:'Bearer sk-…'} }) → union 分支 JSON.stringify → 泄露
```

**所以：`union` / `intersect` 形状的 Config（如 `dsh-mcp-client`）最危险；
普通字段类型写错只在值本身是标量时泄露。** 文档不该说得比实测更严重。

另外 **zod v4 是安全的** —— 它只报类型不报值：
`"Invalid input: expected string, received array"`。风险是 **schemastery 特有的**。

> 引用源码时注意文件名：schemastery **没有** `lib/index.js`，
> 真身是 `lib/index.mjs`（ESM）/ `lib/index.cjs`（CJS）。引 `.mjs` 才能对上行号。

#### 为什么"我们审过日志调用点"不是有效的安全论证

全树约 **313** 个 `logger.<level>(...)` 调用点，审计结果是：**没有任何一个**
传递凭据值、解析后的 `.value`、`Authorization` 头、`process.env` 或原始文档文本。
（grep `apiKey|token|secret|password|authorization` 的命中全是假阳性 ——
那个词出现在静态消息前缀里，如 `dsh-authorization:194/219/231`。）

**也就是说：泄露从来不是某处不小心的日志调用，而永远是"别人构造好的消息里夹带了密钥"。**
这正是为什么 §3.2 的初稿结论错了 —— 我审的是调用点，而密钥从 `Error.message` 里进来。

#### 投递路径（都是"单 Error 参数 → 原样导出"）

`cordis/lib/index.js:1359`（config 解析的 catch）及 `:974, 979, 981, 1094, 1260, 1268, 1311, 1380`；
loader 包装 `cordis-plugin-loader/lib/index.js:307-310`（消息里嵌 `cause.message`，
调用点 `:458, 468, 476, 488, 516, 524, 529`）；
`dsh-settings:494, 589, 594`；`dsh-llm-deepseek:2033`；`dsh-llm-pi-ai:2668, 2674`；
`dsh-credentials:155`；`dsh-credentials-local:465, 600, 704`。

> **脱敏必须作用在"每一条记录"的写路径上，而不是在捕获时对"那个错误"做一次。**
> 因为 `cordis` 会把 `.cause` **再记一条**（见泄密 3），同一个密钥可能被投递**两次**。

#### 确认干净的（§3.2 也该说清什么是安全的）

- **`dsh-credentials-local` 的 `describeYamlError` 是真正生效的缓解** ——
  yaml 解析器确实会把整行附在消息里，而它把那段剥掉了。**这是该照抄的做法。**
- `dsh-llm` / `dsh-llm-deepseek` / `dsh-llm-pi-ai` 没有直接记录密钥
  （`dsh-llm:1596-1611` 刻意只报 ref；`assertValidHeaders` 抛的是头的**名字**、
  从不抛值 —— 这点值得注意，因为头里就装着 `Authorization`）。
- `dsh-host-webserver` 不记录头/体，且全树 `clientError` / `rawPacket` / `HPE_*`
  **零命中**，所以没有原始报文泄露。
- `dsh-api-gateway` / `dsh-web` / `dsh-web-fetch-http` **完全没有** logger 调用。

#### 结论

**落盘前无条件过脱敏层，每一行都过 —— 不只过我们自己那部分。**

`dshmarket` 的规则集**能挡住其中大部分**：
`Bearer sk-…` 命中 bearer 规则、`$.apiKey … sk-…` 命中 `sk-[A-Za-z0-9_-]{8,}`。
**但泄密 4 挡不住** —— `credentialRef` 回显的是用户粘进去的任意字符串，
不保证有 `sk-` 前缀（实测第二条就是 `ctx7sk-` 开头）。
所以要在它的基础上**加一条按"值所在位置"匹配的规则**
（`credential ref "…" must match` 这类形状），而不是只靠前缀。

照抄 `D:\DSH\dsh-home\profiles\web\node_modules\dshmarket\src\log.ts`
（同一问题的成熟答案：第三方插件、给 issue 报告用的日志导出）：

- `homedir()` → `~`（路径脱敏）
- **去掉控制字符** `[\u0000-\u001f\u007f]` —— 防**日志注入**：日志里的换行能伪造额外行
- `sk-***`、`gh[pousr]_***`、`npm_***`、`Bearer ***`、
  `(authorization|token|apikey|api-key|password)` 后面的值 → `***`
- 单条 detail 截断（它用 600 字符）

**要改进/补充它的三点**：
1. 它只记消息字符串，**不记 stack**。诊断日志没有 stack 等于废掉一半 ——
   error 级要带栈。
2. 它没处理 `.cause`。我们要么把 cause 拍平进同一条，要么明确分开记且同样过脱敏。
3. 加"值位置"规则覆盖 `credential ref "…"` 这类无前缀密钥（见上）。

**要照抄它的两点**：写完检查大小并**就地**裁剪（见 §3.3），以及写失败就自停落盘。

#### 正面教材：`dsh-credentials-local` 的 `describeYamlError`

它专门写这个函数，唯一目的就是**不引用出错的那一行**
（注释原话：解析器自己的消息会带上那一行的内容，而那里放着密钥）。
解析错误只报 key/字段名。**该学的是它，不用担心的是它。**
`dsh-llm*` 也没有直接记录密钥（`assertUsableApiKey` 只传 `ref`，
注释写明"把密钥的任何片段回显进日志或 UI，正是这个诊断要避免的失败"）——
**它们只可能从 Config 校验那条路泄**。

### 3.3 落盘

`$DSH_HOME/todo-board/log.ndjson`（与 `board.json` 同目录，本机即
`D:\DSH\dsh-home\todo-board\log.ndjson`）。

- 一行一条 NDJSON，方便机器读也方便人看。
- **大小上限 + 过半裁剪**：dshmarket 用 256 KiB 上限、超了就保留最新一半。
  它踩过一个坑值得记下：只在挂载时裁剪会导致长命进程里上限失效
  （实测 2 万条事件长到 3.2 MB），所以**每次追加后检查**。
- 写失败（只读盘/满盘）→ **停用落盘但内存日志继续**，不能因为一个坏写就让后续每条都失败。
  这也是 dshmarket 的处理。
- 原子性：追加型日志不需要 `board.json` 那种"临时文件+rename"（那是全量覆盖用的）。
  直接用本插件已有的 `node:fs` 就够。
- **文件权限设 `0o600`**：`board.json` 没设 mode，而这个文件更敏感（可能含别的插件的
  错误上下文），该收紧。

> **不要**为此引入 `@deepseek-ai/dsh-atomic-write`。三重理由：
> 1. 实测解析不了：插件在 profile 里是 junction，裸模块说明符按**真实路径**解析 ——
>    从 `D:\DSH\plugin\dsh-todo-board\lib\index.js`（真身）解析 `@deepseek-ai/*`
>    是 `MODULE_NOT_FOUND`，从 junction 路径才 OK。`D:\DSH\plugin\{,dsh-todo-board}\node_modules`
>    也都不存在。所以 `lib/index.js:8-10` 那句"刻意不 import 任何 `@deepseek-ai/*`"依然成立。
> 2. **语义也不对**：`writeFileAtomic` 是**整文件替换**原语，不是追加器；
>    `withFileLock` 每次追加都抢一把 2 秒超时的锁，纯属自找麻烦。
> 3. `ctx.storageDomain.open(defineDomain(...))` **同样**卡在 import 上
>    （`defineDomain` 也要 import），而且数据模型更不合适：**没有 append**，
>    `put` 是整条替换；domain 打开时会把**所有记录读进内存并逐条 zod 校验**，
>    日志越长打开越慢；也没有轮转和大小上限。所以日志用 `node:fs` 追加是**正解**，
>    不是妥协。

### 3.4 面板

- 标题栏加一个按钮（和现有的皮肤 `▤`、折叠 `–` 并排），**点击切换 TODO 视图 ↔ 日志视图**。
  复用现有浮窗、拖动与缩放，不新增窗口。
- 数据通路：**扩展现有 2.5s 轮询**，不引入新传输。
  现有轮询在 `client/client.js:583-584`（`fetch(ROUTE)`）+ `:989`（`setInterval(refresh, 2500)`），
  host 路由在 `lib/index.js:1398-1403`。做法：
  - 给 `snapshotPayload()` 加 `logCursor`（即 exporter 的 `sn`）与 `logLines`；
  - 面板请求 `GET /dsh-todo-board/api?logs=1&since=<sn>`；
  - **只在日志视图打开时才带 `logs=1`**，平时轮询负载一点没变 ——
    这顺带满足了"平时不暴露给用户"这条要求。
  - `Message.sn` 是**全进程单调计数器**（`logger.ts:152` 的 `++this.service._snMessage`），
    所以它是有效的跨插件排序游标，可以直接当 `logCursor` 用。
  - 诊断日志 2.5s 的延迟无所谓，不需要实时尾随。
- **不引入 SSE**（虽然可行）：先例是 `dsh-client-hmr` 的 `/plugins/events`
  （`res.writeHead(200, {'content-type':'text/event-stream', ...})` + 一个 `connections` Set
  + disposer 里销毁全部连接；`dsh-host-webserver` 对 `text/event-stream` 免 gzip）。
  2.5s 的场景下它不带来任何收益，只多一条要维护的失败路径。
- **更不要碰 `dsh-client-connection`**：它没有可复用的通用事件总线。
  host 半的 `rpc.handle` 注册的是**请求/响应**（无推送）、`rpc.intercept` 只允许 `/api`
  且**只能有一个**（已被占用）、`fetch.register` 要求路径在 `/api` 之下；
  浏览器半的 `ClientConnectionRpc.open` 文档明写"Browser transports omit this method;
  API Gateway owns their WebSocket mux"。真正的推送要 `dsh-api-gateway` 的 Typert Remote
  WS mux（`/api/remote.mux`），那需要 import `@deepseek-ai/*` —— 而我们做不到（§3.3）。
- 日志视图内容：时间 · 级别 · 来源插件 · 一行摘要（可展开看完整 detail）。
  顶部三个过滤：级别（error/warn/info/debug）、来源（仅本插件 / 全部）、关键字。
  底部两个动作：**复制**、**导出为文本文件**（照 dshmarket 的导出形态，带环境头部）。
- **出错时怎么"给提示"而不打扰**：日志按钮上点一个小圆点（照现有 `dshtb-badge.warn`
  的做法），表示"有新的 error"。用户不看就一直在，看了（打开日志视图）就清掉。
  这满足"平时不暴露、出错时可见"。
- 日志视图本身是"开发者视图"：措辞直白、等宽字体、允许长文本换行，不做美化。

### 3.5 真正的工作量：把失败路径记下来

现在整个 host 半边只有 **3 处** logger 调用（`lib/index.js:593`、`917`、`1129`），
但至少有 **7 条失败路径只改了状态、没有任何日志**：

| 位置 | 现状 | 应记 |
| --- | --- | --- |
| `load()` 读板失败 | 只设 `storageError` | error + 异常 |
| `save()` 写板失败 | 只设 `storageError` | error + 异常 |
| `markLost('no-session')` | 只记 `lostReason` | warn + 目标会话 id |
| `markLost('spawn')` | 只记 `lostKind` | error + 建会话异常 |
| `markLost('preset')` | 只记 `lostKind` | error + preset 解析异常 |
| `imageRefusal` | 只记 `lostKind` | warn + 模型/图片数 |
| 图片入库失败 `admitImages` | 只返回 error 文本 | warn + 异常 |
| HTTP 路由 500 | 只回状态码 | error + 栈 |

**这才是本项的实质工作**：日志功能不难，难的是让每条失败路径都留下足够还原现场的信息。
没有这一步，日志视图只是个空壳。建议每条至少含：待办 id、目标会话 id、目录、异常 message。

---

## 4. 需要你定的事（**已定，v0.9.0 按此实施**）

1. **默认范围** → **只记本插件**（`levels: { 'dsh-todo-board': 3, default: 0 }`）。
2. **级别默认值** → 采集端**全级别捕获**（含 debug），面板视图**默认只显示 error+warn**，
   info/debug 各是一个开关。debug **不落盘**这个最初的设想**没有采用**：落盘与内存走同一条
   `redact` 之后的写路径，风格更统一；文件另有 256 KiB 上限与过半裁剪兜底。
3. **日志按钮位置** → 标题栏第三个图标（与皮肤、折叠并排），**平时不打眼，出错时亮一个小圆点**。
4. **导出** → **复制**与**导出 .txt** 都做了；两条路径都会**再过一次脱敏**（见 §3.2 的理由）。

---

## 5. 实施记录（v0.9.0）

### 5.1 采集与门控

`ctx.logger.exporter({ levels: { 'dsh-todo-board': 3, default: 0 }, export })` —— **只注册一个**，
且**不靠 `exporter()` 返回的 disposer 摘除**（§1.3 那个 bug），回收交给 fiber 卸载。

实测确认（用真实 cordis 跑过，不是推理）：

```
our types:      ["debug","info","warn","error"]   ← 自己的四个级别全进得来
sibling types:  ["error"]                          ← 兄弟插件只收 error
```

`Message.args` 确实是**未格式化**的原始参数（`'code=%s n=%d obj=%o', 'ABC', 42, {k:1}` 原样到达），
所以 §1.4 的结论成立，格式化器是本插件自带的。

`fiber.deref()?.runtime?.name` 取来源包名也实测可用（`'dsh-todo-board'`），
它同时是"本插件/其他插件"这个来源筛选的依据。

### 5.2 补齐的失败路径

`markLost()` 是**所有派发失败的唯一收口点**，日志加在那里而不是每个调用点 ——
这样不可能有哪条失败路径被漏掉。它记录：待办 id、目录、模式、目标会话、**第几次失败**、原因。
`no-session` / `image` 记 warn，其余记 error。

另补：

| 位置 | 记了什么 |
| --- | --- |
| `load()` 读板失败 / 结构不对 / 跳过坏记录 | error / error / warn（含跳过条数） |
| `save()` 写板失败 | error + 异常 |
| `spawnSession` 的 preset 解析、建会话失败 | error + 异常对象（`markLost` 只拿到摘要文本，栈要在这里留） |
| `agents` 服务不可用 | error |
| 图片入库失败 | warn + 张数 + 首张文件名 |
| `imageRefusal` | warn + 图片张数 + 模式 |
| 新会话未归入工作区 | warn |
| 定时派发失败、回合钩子失败、HTTP 500 | error + 异常 |
| 路由信任校验拒绝 | warn（**上限 20 条**，避免重试循环刷屏），含 host/origin/sec-fetch-site |

### 5.3 本文原稿没覆盖的：路由信任围栏（**先修这个才敢挂日志**）

**问题**：DSH 对 `/api` 有一道 Host/Origin 围栏（`dsh-client-connection`，注释自称防
"confused-deputy"），但它**按通道注册**（`register(owner, channel, ...)`），
本插件的 `/dsh-todo-board/api` **不在覆盖范围内**。实施前实测：

```
GET  /dsh-todo-board/api                    （不带任何凭据）→ 200，返回整个板子
GET  /api/<any>                             （不带任何凭据）→ 401
POST /dsh-todo-board/api  Content-Type: text/plain          → 200，动作被执行
```

三个后果：**CSRF**（`text/plain` 是 CORS 安全列表值，不触发预检，而原 `readJsonBody` 不看
content-type，于是任意网页都能增删待办甚至派发任务）、**DNS rebinding**（可读走响应）、
以及**日志落地后成为日志泄露通道**。若有人把 host 绑成 `0.0.0.0`，还会变成局域网可读。

**处理**：在插件内复刻同一条规则（`isLoopbackHostname` / `parseAuthority` /
`isTrustedAuthority` / `requestRejection`），挂到两条路由上。
`trustedHosts` 从 `ctx.get('webRuntime')` 读，**每次请求现读而不是加载时缓存** ——
该服务由兄弟行提供，本插件挂载时未必已存在；读不到就退化为仅回环。

`Host` 是承重的那一项，这不是实现细节：明文 HTTP 下浏览器对**读**请求不带 `Origin`
也不带 Fetch-Metadata（那些头只发给可信目标），所以一个没有任何标记的请求仍可能是
被 rebinding 的浏览器读取，而 **`Host` 正是 rebinding 无法伪造的那个头**。

**为何值得修**：这个缺口在本功能之前就存在，但它的后果被日志放大了
（从"能改板子"变成"能读走诊断上下文"）。测试见 `tools/smoke.mjs` 的 `trust` 组，
以及 `tools/check-http.mjs` 用**真实 `node:http` 服务 + 裸客户端**验证的版本 ——
`fetch` 会按 URL 重写 `Host`，表达不了 rebinding 那个场景，所以那一层必须用裸请求测。

### 5.3.1 测试方式的盲区（实施中补的第 5 个套件）

写这段时发现"套件全绿"本身可能是个假象，于是补了 `tools/check-live.mjs`：

- `tools/smoke.mjs` 的 `inject` 是**直接调回调**，而真实 cordis 要等服务被 **`ctx.reflect.provide`**
  出来才唤醒。如果这个语义差有影响，**两条路由在真机上根本不会注册**，而所有基于 stub 的测试**照样全绿**。
- 同理，stub 的 logger 是**凭记忆重写**的 `levels` 门控；真实的 `LoggerService` 才是决定
  "我们自己的 debug 到底进不进得来"的那一个。

补测后实测确认两件事都成立（路由会注册；自己的 debug 确实被收下、兄弟插件的 debug 被挡掉）。
这条经验值得记下来：**stub 越多，"全绿"能证明的东西越少** —— 关键语义要有一个用真实运行时的套件兜着。

### 5.3.2 复刻会漂移，所以要逐例对表

围栏是从 harness 那条规则复刻的（§5.3），而复刻一旦漂移，**方向必然是更松**，
且没有任何别的测试会发现 —— 于是补了 `tools/check-fence-parity.mjs`：
把**两边**的谓词都从各自源码里取出来（harness 那个是模块私有的，用 `new Function` 就地重放），
在 72 个 host/origin/fetch-metadata 组合上逐例比较，不一致就点名是哪个组合。

覆盖的边界包括：`127.0.0.0/8` 各写法、`localhost` 大小写、`[::1]`、端口有无与补零、
`128.0.0.1`（**不是**回环）、`127.0.0.1.example.com`（**不是**回环）、
`0x7f.0.0.1`（回环的十六进制写法，**必须拒绝**）、`127.1`（简写，**必须拒绝**）、
以及 origin 同源/异源/非法、`sec-fetch-site` 三种取值。

**已实测它不是空转**：把本插件围栏里的 `sec-fetch-site` 那行改弱，它立刻报出具体那一个用例。

### 5.4 数据通路与"平时不暴露"

- **日志正文只在视图打开时才返回**：`GET /dsh-todo-board/api?logs=1&since=<sn>`。
  视图关闭时轮询负载与改动前**逐字节相同**，这正是"平时不能在面板中暴露给用户"的落实。
- **唯一的例外**是 `logAlert`（一个 `sn` 数字 + 时间戳），每次轮询都带。
  没有它就只能在用户打开日志之后才亮圆点，而圆点的意义恰恰是"你不用打开也知道出事了"。
  它不含任何日志文本。
- 用 `Message.sn`（全进程单调计数）当游标；`since` 过滤 + `truncated` 标记，
  环被回收过会明说"有更早的记录已被丢弃"，而不是让空列表冒充"什么都没发生"。
- **不引入 SSE**、**不碰 `dsh-client-connection`**：理由同 §3.4，仍然成立。

### 5.5 面板

- 标题栏第三个按钮（`dshtb-log`，与 `dshtb-fold`/`dshtb-skin` **各自独立 class**，
  遵守仓库既有的"一个 class 只指一个控件"约定），图标 `⚙`，打开后变 `←`。
- **圆点**表示"有未读的 error/warn"；**打开视图即视为已读**。
  `!logOpen` 是条件的一部分而不是优化：视图开着时新来的错误不该再点亮圆点。
- 视图顶部：级别开关（error/warn/info/debug，**至少保留一个**，否则空列表会被误读成"没有日志"）、
  来源循环（本插件 / 其他插件 / 全部，存 localStorage）、关键字过滤。
- 底部：**复制**、**导出 .txt**（带环境头部与"贴出去前请自行确认"的提醒）、**清空显示**
  （**只清面板，不动主机记录** —— 诊断面上一个会删掉证据的按钮是个陷阱）。
- 列表**最新在上**：打开它的理由通常就是刚坏掉的那件事。

### 5.6 与 dshmarket 参考实现的差异

`dshmarket/src/log.ts` 的三点改进**都已落实**：error 级带 stack；`.cause` 被拍平进同一条
（并注明 cordis 会把它**单独再记一条**，实测复现）；补了"值位置"规则覆盖无前缀密钥。

它的规则集里有一条**没有照抄**：`(authorization|token|…)` 后**接受任意空白**再吃掉一个 token。
这会把普通诊断变成乱码 —— `apiKey expected string but got X` 会变成 `apiKey ***string but got X`，
把这条记录之所以值得留的那句话吃掉。本实现要求**真的赋值分隔符**（`:` 或 `=`）。
这是被 smoke 的脱敏测试抓出来的，不是 review 出来的。

### 5.7 脱敏规则（承重结构）

按顺序：归位 `~` → 去控制字符（保留 `\n`/`\t`，栈需要它们；NDJSON 会转义，所以不会伪造记录）→
已知前缀形状（`sk-` / `gh*_` / `npm_` / `Bearer`）→ `credential ref "…"`（**必须排在通用键值规则之前**，
否则通用规则会把 `ref` 当值吃掉、把引号里的密钥留下）→ JSON 键值（保留引号，dump 才不会被打散）→
通用键值（要求 `:`/`=`）→ `but got …`（**值不能以 JSON 标点开头**，否则整个配置 dump 会被吞成一个 `***`，
而那正是最该看清的一条路径）。

**已知未覆盖**：JSON dump 里、键名不像密钥、值也没有可识别前缀的密钥。风险是**具体的、可枚举的**，
不是"日志都危险" —— 这是留下的那条边。

---


## 附一：本文档的结论都经过实测复现

初稿有两处判断是错的，都已在正文更正，这里集中说明，以免将来有人照旧稿实现：

| 初稿的说法 | 实测结论 |
| --- | --- |
| "用 cordis 自己的 `Logger.format` 格式化" | **错**。`Message.args` 是原始参数（占位符不解析），`Logger.format` 是 `Logger` 类的静态方法，插件拿不到 → **自己写格式化器**（§1.4） |
| "抽查了凭据相关包，全进程模式风险可控" | **错，且危险**。审计只看了 logger 调用点，而密钥是从 `Error.message` 进来的。已复现**四条**路径（§2.1、§3.2），其中 `dsh-mcp-client` 那条在本机有真实密钥实例 → **脱敏是承重结构，不是加固** |

正确的、经复核保留的结论：§1.1（缓冲丢 warn/debug）、§1.2（`inject:['logger']` 死锁）、
§1.3（`exporter()` disposer 有 bug，但 fiber 卸载是干净的）、
§3.3（不能 import `@deepseek-ai/*`，且 `storageDomain` 数据模型也不对）。

### 实施阶段（v0.9.0）新增的更正

上面两条是**设计期**发现的。实施时又抓到三条，同样是"想当然"而不是"实测"造成的：

| 实施中最初的想法 | 实测/测试结论 |
| --- | --- |
| 插件 fiber 的 logger 名可以靠 `ctx.plugin(fn, null, { name })` 指定 | **错**。第三参不是 options；名字来自插件对象的 `name`，loader 传的是模块命名空间。用函数名会得到 `'plugin'` 之类的名字，`levels` 就永远命中不了自己的行 —— **和 §1.1 的 buffer 一样是"静默丢掉自己的日志"**，所以这条被专门验证过 |
| `credential ref "…"` 规则放哪都行 | **错**。必须排在通用键值规则**之前**，否则通用规则把 `ref` 当值吃掉、引号里的密钥原样留下。smoke 的脱敏测试抓到的 |
| 照抄 dshmarket 的 `(authorization\|token\|…)` + 任意空白规则 | **会破坏诊断**。`apiKey expected string but got X` → `apiKey ***string but got X`。改为要求真的 `:`/`=`。也是测试抓到的 |
| `but got` 规则直接吃掉下一个 token | **会吞掉整个 JSON dump** —— 而那正是 `dsh-mcp-client` union 失败那条最该看清的路径。已加"值不能以 JSON 标点开头"的排除 |
| `bearer\s+\S+` | **会吃掉 JSON 字符串的收尾引号**，dump 结构被打散。值类已排除引号 |

共同点：**每一条都是被测试或实测输出抓出来的，没有一条是靠读代码看出来的**。

---

## 附二：与本功能无关、但建议处理的本机事项

**`profiles/web/cordis.patch.yml` 里有一个内联的真实 API 密钥。**

```yaml
env:
  CONTEXT7_API_KEY: ctx7sk-297eea2b-…-20cb6d5f4bc4
```

它位于 `dsh-mcp-client` 的 config 里 —— 而那正是**唯一会在校验失败时把整个配置
（含 `env` 与 `headers`）dump 进日志**的形状（§3.2 泄密 1）。

**今天没有泄露**：该行是 `disabled: true`，而 loader 会跳过 disabled 行
（`cordis-plugin-loader/lib/index.js:391` `if (this.disabled) return;`），
所以它根本没被校验。**但它会在你启用这个 MCP 服务器的那一刻武装起来** ——
而"启用一个已管理的 MCP 服务器"是完全正常的操作。

**建议**（与本功能是否实现无关）：
1. **轮换这个 key** —— 它已经出现在本会话的 MCP 目录上下文里，也就是说已经进了转录。
2. 把它移到 `$DSH_HOME/.credentials.yaml`，而不是留在一个会被校验回显的 loader 配置里。
   `dsh-credentials-local` 对那个文件处理得很小心（`describeYamlError` 专门避免引用出错行）。
3. 顺手清掉 `settings.yaml` 里的 `jet-hub.disabledModels` 等无关项**不是**本项内容，
   只是提醒：本机还有几处"配置文件里放敏感值"的地方值得统一盘点。

> 另：审计过程产生的临时文件（`.audit-tmp-yaml.mjs`、`_probe*.mjs`）已确认全部删除，
> 不在 WIP 里。
