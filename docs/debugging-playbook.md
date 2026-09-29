# 从「登录超时」到一行修复：排查思路笔记

> 记录一次真实排查（firebase-admin 在代理环境下超时）。重点不是这个 bug，而是**这套找 bug 的方法**。

---

## 0. 一句话总结

**故障在哪一层，就在哪一层修。找到「哪一层」的办法是：让每一层自己开口说话。**

你的判断其实一直是对的：`超时 → cookie 没写进去 → 被弹回登录页`。你卡住的只是最后一环——**为什么超时**。而两个 AI 给的答案，一个说「删掉错误源头」（在应用层绕过传输层故障），一个说「加代理」（方向对，但没说清**加在哪一层**）。关键在于：

> **"加代理"不是一个动作，而是"让某一层代码去读代理变量"。加在错误的层，等于没加。**

---

## 1. 先建立分层模型（这是所有排查的起点）

一个请求从你的代码到 Google，路上要经过好几层，**每一层都可能把配置吞掉**：

```
你的代码
  └─ firebase-admin 的 HttpClient      ← 库自己的 HTTP 实现
       └─ Node 原生 https.request       ← Node 的传输层
            └─ [ 代理 或 直连 ]          ← 环境（墙 / Clash）
                 └─ Google
```

同一台机器、同一个环境变量，**不同层态度可以完全不一样**。这次就是：

| 层 | 谁在用 | 读 `HTTPS_PROXY` 吗 | 结果 |
|---|---|---|---|
| gRPC | Firestore（注册写库） | ✅ 自己实现了 | 通 |
| gaxios | 取 OAuth token | ✅ 自己实现了 | 通 |
| **Node 原生 https** | **firebase-admin 的 Auth 请求** | ❌ **完全没写** | **直连被墙，25s 超时** |

所以「注册能成、登录不能」不是玄学——**这两条路唯一的差别就是走了不同的层**。

> 💡 **现象本身就是线索。** "A 功能正常、B 功能不正常"这类描述，往往已经帮你圈定了故障范围。第一件事就是问：「A 和 B 在技术栈上差在哪一步？」

---

## 2. 排查的每一步，都必须是一个「是非题」

这是我认为最值得带走的一条原则：

> **每做一次实验，要能回答一个能用「是/否」回答的问题，并且能排除掉一整类可能性。**
> 如果实验结果只是"还是不行"，那这次实验的信息量约等于零。

看这次的四步，每步都排除了什么：

### Step 1 · 对照实验：`curl` 直连 vs 走代理

```bash
curl -s -o /dev/null -m 12 -w "%{http_code} %{time_total}s\n" https://identitytoolkit.googleapis.com/
curl -s -o /dev/null -m 12 -x http://127.0.0.1:7897 -w "%{http_code} %{time_total}s\n" https://identitytoolkit.googleapis.com/
```

```
direct: 000 11.957324s   ← 超时（连不上）
proxy : 404  2.735875s   ← 404 也是"通"！服务器回话了
```

**回答了**：墙是墙、代理是好的吗？→ 是。
**排除了**：代理端口配错、代理没开、目标域名被删。

> ⚠️ 这里有个新手陷阱：看到 `404` 就以为失败。**"服务器回话了"本身就是好消息**——404 是 HTTP 层的事，说明 TCP/TLS/代理隧道全都通了。

### Step 2 · 用真 SDK 复现，而不是读文档猜

写个 20 行探针，用**和项目完全一样的方式**调 API，只测时间：

```
=== 无代理 ===
getUserByEmail -> 63874ms | app/invalid-credential
=== 有代理 ===
getUserByEmail -> 33533ms | app/network-timeout     ← 还是失败！
firestore.get  -> OK in 2556ms                      ← 但 Firestore 是通的！
```

**回答了**：SDK 到底有没有走代理？→ **没有**（加了代理变量依然超时）。
**排除了**：把问题甩给网络的思路。同时意外收获：**同一个进程里 Firestore 通、Auth 不通** → 故障被锁定在 Auth 这条调用链上。

> 💡 **为什么不直接读源码猜？** 因为"库到底读不读某个环境变量"是**作者的选择**，六七个库有六种做法。读源码容易漏，**实测才作数**。先用实验锁定范围，再用源码解释原因——顺序不能反。

### Step 3 · 「假目标」技巧（这次最关键的临门一脚）⭐

如果 Step 2 还不能区分「OAuth 那一层」和「Auth 请求那一层」谁没走代理，就把代理指向一个**不存在的端口**：

```bash
HTTPS_PROXY=http://127.0.0.1:9999 node probe.mjs
```

```
getUserByEmail -> 732ms | app/invalid-credential
                 Failed to connect to proxy 127.0.0.1:9999 (ECONNREFUSED)
```

**回答了一个非常精确的问题**：这一层**到底有没有在读**代理变量？
→ **有**（否则它会照样去直连、照样慢慢超时；而它 732ms 就报错了，说明它真的去找那个代理了，只是门牌号不存在）。

**推理链完成**：既然 OAuth 那层读了代理变量、且代理本身没问题（Step 1），那么**超时的那一层一定没读** → 凶手 = 剩下的那个，Node 原生 https。

> 🧰 **这个技巧可以到处用**：想知道"某个配置到底有没有被读进去"，就把它设成一个**一眼就会炸的非法值**。
> 配了没用 = 静默失败（最难查）；配了报错 = 说明它读了。**让静默失败变成响亮的失败**，是排查的核心手法之一。

### Step 4 · 读源码，把「猜」变成「证据」

带着 Step 3 的结论，去 `node_modules` 里找一句话确认。**这一步只花了两分钟**，因为目标已经极其明确。

---

## 3. 怎么读源码（你问的核心）

### 3.1 什么时候该读源码？

**判据：实验已经把范围缩到 1~2 个可疑层，但你无法从外部区分它们。**

❌ **不要一上来就读源码**——面对一个陌生的库，你连该看哪个文件都不知道，只会淹没在文件海中。
✅ **实验是把范围缩小的工具，源码是把结论钉死的工具。**

这次触发读源码的信号是：「这个库的行为和我的预期不符（我以为它该走代理，它没走）」+「范围已经缩到一个函数了」。

### 3.2 四个具体手法

#### 手法 A：用**报错信息里的字符串**反查 —— 最好的入口 🥇

错误信息是你手里最独特的字符串，直接 grep：

```bash
grep -rn "timeout of" node_modules/firebase-admin/lib/utils/api-request.js
```

命中 `api-request.js:557`，而**往上翻 30 行就是真相**：

```js
// node_modules/firebase-admin/lib/utils/api-request.js:542-557
execute() {
    const transport = this.options.protocol === 'https:' ? https : http;
    const req = transport.request(this.options, (res) => {   // ← 直接调原生 https！
        this.handleResponse(res, req);
    });
    ...
    const timeout = this.httpConfigImpl.timeout;
    const timeoutCallback = () => {
        req.destroy();
        this.rejectWithError(`timeout of ${timeout}ms exceeded`, 'ETIMEDOUT', req);  // ← 你看到的报错
    };
    req.setTimeout(timeout, timeoutCallback);
```

**看到 `transport.request()` 就直接下结论了**：它绕过了所有"高级"HTTP 客户端（那些会读代理变量的），直接用手搓的原生请求。原生 `https` **从设计上就不读代理环境变量**。

#### 手法 B：看文件顶部的 `require` —— 一眼看出它用什么底层机制

```js
// node_modules/firebase-admin/lib/utils/api-request.js:26-28
const http = require("http");
const https = require("https");
const http2 = require("http2");
```

**这是个通用信号**：看到 `require("https")` / `require("http")`，就要立刻警惕"它不认代理"；看到 `require("gaxios")` / `fetch` / `require("undici")`，才需要考虑代理变量。

> 记住这个映射关系，比读一堆代码都快：
> `require("https")` → 原生层，不读代理 ❌　|　`gaxios` / `axios` / `fetch` → 看你运气（各自实现不同）

#### 手法 C：先看 `.d.ts` 找「有没有开关」—— 比读实现快 10 倍

你想知道「能不能给它传个代理」，先翻类型定义：

```ts
// node_modules/firebase-admin/lib/utils/api-request.d.ts
export interface HttpClientOptions {
    timeout?: number;      // ← 只有 timeout
    // 没有 agent，没有 proxy，什么都没有
}
```

**结论一秒得出**：公开 API 层面**根本没有传代理的入口**。

这一条直接解释了你说的「绕开它要改的逻辑很多」——不是你不会写，而是**这个库没给你那条路**。想让它走代理，你只能：

1. 去 patch `https.globalAgent` / 猴补它的内部模块（脆弱，且它还有一条 HTTP/2 路径未必管得住）；
2. 或者**干脆别用 Admin SDK 做登录**，自己调 REST、自己造 session cookie → 于是 `signIn` / `setSessionCookie` / `getCurrentUser` / 两个 layout 全要重写。

**这就是"要改一堆逻辑"的真正原因**——你被迫从别人写好的抽象层，下移到传输层自己干活。

#### 手法 D：对照两个「做同一件事但结果不同」的库 —— 差异就是答案

这是前面那条"注册能成、登录不能"的延伸用法。既然 gaxios 走代理成功、firebase-admin 超时，就把两段代码并排看：

```js
// node_modules/gaxios/build/src/gaxios.js:429-448  —— 成功的一方
const proxy = opts.proxy ||
    process?.env?.HTTPS_PROXY || process?.env?.https_proxy ||
    process?.env?.HTTP_PROXY  || process?.env?.http_proxy;   // ← 自己主动读！
...
else if (proxy && urlMayUseProxy) {
    const HttpsProxyAgent = await _Gaxios_getProxyAgent();
    opts.agent = new HttpsProxyAgent(proxy, {...});          // ← 自己建隧道代理
}
```

**对照结论一目了然**：

| | 读代理变量？ | 建代理 agent？ |
|---|---|---|
| gaxios | ✅ 有 | ✅ 有 |
| firebase-admin HttpClient | ❌ 没有 | ❌ 没有 |

> 💡 所谓"支持代理"，**本质就是这两件事**。缺任何一件都等于不支持。
> 顺便解释了为什么 `HTTP_PROXY` 对一半库有效、对另一半无效——它只是个**约定**，没有任何强制性，谁读谁生效。

### 3.3 读 `node_modules` 里被打包的代码，有哪些技巧

被打包/编译过的代码确实难看，但**不用全懂**：

- **变量名被压成 `_b` / `_c`，但字符串、结构、控制流都还在** → 只抓关键行，其余跳过。
- `__classPrivateFieldGet(...)`、`__importStar(...)` 这类是 TypeScript 编译产物，**直接无视**。
- **优先找 `if` 和 `return`**——控制流比变量名重要得多。
- **优先看 `.d.ts`**（类型定义没被打包，可读性最好），再决定要不要看实现。
- 用编辑器的「转到定义」比 grep 更舒服；但 grep 更通用，尤其在 AI 助手里。

---

## 4. 最终证据链（三个库，胜败分明）

| 库 | 传输方式 | 读代理变量？ | 源码证据 |
|---|---|---|---|
| `@grpc/grpc-js` | gRPC | ✅ | Firestore 实测 2.5s 通 |
| `gaxios` | 自建 `HttpsProxyAgent` | ✅ | `gaxios.js:429-448` |
| firebase-admin `HttpClient` | **原生 `https.request`** | ❌ | `api-request.js:543` |

**修复 = 让最下面那层也认代理**：Node 24 的 `NODE_USE_ENV_PROXY=1`（等价 `--use-env-proxy`）会在进程启动时，把全局 agent 换成"会读代理环境变量"的实现。于是——**firebase-admin 的代码一行没动，它只是忽然发现自己发出的请求能通了**。

效果对比：

```
修复前: getUserByEmail -> 33533ms | app/network-timeout   ← 超时挂死
修复后: getUserByEmail ->  3111ms | auth/user-not-found   ← 正常业务错误
```

> ⚠️ 注意"正常业务错误"：`user-not-found` 是**好消息**，说明请求真的到达 Google 了。**判断修好没有，要看"错误类型有没有从传输层错误变成业务层错误"**，而不是看"没报错"。

---

## 5. 可复用清单：遇到「超时 / 连不上」类问题

```
1. 画分层图          谁调谁？请求路上经过哪几层？
2. 找「对照组」      同样能用/不能用，两者的差异点就是故障范围
3. 对照实验          直连 vs 走代理 / 旧环境 vs 新环境，变量只留一个
4. 假目标技巧        把配置设成一眼就炸的非法值 → 判断"这一层到底读没读它"
5. 锁定到层          用上面几步把范围缩到 1~2 层
6. 读源码钉死结论    grep 报错字符串 → 看 require → 看 .d.ts → 找对照库
7. 在最底层修        一次覆盖所有调用方；在应用层修要逐个打补丁
8. 端到端验证        验证业务结果，不验证"没报错"
```

**第 7 条的心法**：

> **在应用层修，你要挨个调用方打补丁；在传输层修，一次修好所有人。**
> 所以"删掉错误源头"这类建议看起来最少改动，实际上是把技术债转移到了业务代码里。

**第 8 条的例子**（可以照抄的习惯）：光看到"不报错了"不算数，我另外造了一个**真实 ID token**（用 Admin SDK 签发 custom token → 走 REST 换成 idToken），然后跑完整链路：

```
auth.getUserByEmail      -> OK
createSessionCookie      -> OK, 839 chars    ← 之前就是死在这里
verifySessionCookie      -> OK -> uid ...
getCurrentUser result    -> user found -> isAuthenticated() === true
```

**"能跑通"和"能证明跑通"是两件事。**

---

## 6. 探针模板（想抄就抄）

排查网络/SDK 问题的万用探针：**打印环境变量 + 给每步计时 + 打印错误码**。

```js
// probe.mjs
import nextEnv from '@next/env'; const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);          // 用项目真实的 env 加载方式

console.log('HTTP_PROXY =', process.env.HTTP_PROXY);        // ① 环境变量真的进来了吗
console.log('NODE_USE_ENV_PROXY =', process.env.NODE_USE_ENV_PROXY);

const timed = async (name, fn) => {                          // ② 每步都计时
  const t = Date.now();
  try { await fn(); console.log(`${name} -> OK in ${Date.now()-t}ms`); }
  catch (e) { console.log(`${name} -> ${Date.now()-t}ms | ${e.code} | ${(e.message||'').slice(0,120)}`); }
};

await timed('getUserByEmail', () => auth.getUserByEmail('nobody@example.com'));
```

**为什么要写成探针而不是直接在项目里试？**
- 隔离变量：排除 React / Next 路由 / 组件逻辑的干扰，只剩"网络 + SDK"两件事；
- 可对比：同一段代码加不同环境变量各跑一次，**差异就是答案**；
- 有数字：`33.5s` 和 `3.4s` 是能拿来做判断的证据；"感觉卡了很久"不是。
- 判据标准化：看**错误码**（`app/network-timeout` vs `auth/user-not-found`）比看文案可靠。

---

## 7. 最后，关于「思考这类问题」的心法

1. **先测量，再推理。** 大部分时间花在了"我以为"上。一条 `curl` 命令能顶半小时的猜测。
2. **每步只回答一个是非题。** 做完实验不能排除任何可能性的实验，等于没做。
3. **让失败变响亮。** 静默失败是最难查的；用非法值、假端口、假 key 逼它出声。
4. **现象即线索。** "为什么 A 行 B 不行"，答案就藏在 A 和 B 的差异里。
5. **先锁范围，再读源码。** 源码是用来钉死结论的，不是用来大海捞针的。
6. **在最底层修。** 越靠近故障发生的那一层，改动越小、覆盖越广。
7. **验证要看业务结果。** 换到正确的错误类型、跑通完整链路，才算真的修好。

---

*本文档是学习笔记，不属于项目运行代码，可随意移动/删除。*
