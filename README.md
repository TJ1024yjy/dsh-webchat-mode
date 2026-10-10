# dsh-webchat-mode

给 **DeepSeek Harness（DSH）** 桌面版加一个「网页版式聊天模式」：**能联网搜索、能读工作区文件、能记笔记，但改不了任何东西**。

对照的标尺是 DeepSeek 网页版免费聊天 —— 打开就能问，能查网上的资料，但不会动你的项目。

> 这是一个 DSH 插件（Cordis bundle），同时包含 **host** 与 **client** 两半：
> host 负责按会话施加能力边界，client 负责在输入框那一行画出切换控件。

---

## 三个模式

| 模式 | 联网搜索 | 读工作区文件 | 记忆/日历 | 改文件 · 跑命令 · 委派 |
|---|---|---|---|---|
| **`agent`**（默认） | ✅ | ✅ | ✅ | ✅ 完整能力 |
| **`webchat`** | ✅ | ✅ | ✅ | ❌ 一律拒绝 |
| **`chat`** | ❌ | ❌ | ❌ | ❌ 纯文本对话 |

**`webchat` 模式放行的工具**（共 34 个）：

- 联网检索与抓取 10 个（`web_search`、`web_fetch`、`research`、`advanced_search`、`multi_search`、`platform_search`、`video_search`、`domain_search`、`cache_search` …）
- 工作区读取 4 个（`read`、`glob`、`grep`、`read_image`）
- 交互 2 个（`ask_user_question`、`present`）
- 记忆 15 个 + 日历 4 个（`memory_*`、`calendar_*`）

**为什么记忆工具在"只读模式"里也放行？** 因为记忆/日历写的是 DSH 自己的记忆目录（`~/.dsh/memory/`），性质是**记笔记**，不是改用户的项目。而 `plugin_manager`、`ssh_*`、`mcp__github__*` 这类**会动外部世界**的工具仍然禁用。

---

## 安装

本插件是一个 DSH bundle，装进某个 profile 即可（以 `desktop` profile 为例）：

```bash
# 1) 把本仓库放到任意目录，例如 ~/.dsh/plugins/dsh-webchat-mode
# 2) 在 profile 的 package.json 里加依赖 + bundle
```

profile 的 `package.json` 需要两处：

```jsonc
{
  "dependencies": {
    "dsh-webchat-mode": "link:/absolute/path/to/dsh-webchat-mode"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其他 bundle
        "dsh-webchat-mode"
      ]
    }
  }
}
```

然后在 **DSH 桌面版 → 设置 → 插件** 里确认该行已启用，**重启桌面版**生效。

> ⚠️ **改完插件代码必须重启宿主**。DSH 按 URL 缓存 ESM 模块，连 `package.json` 的 `main` 解析结果都会被缓存 —— 用界面上的禁用/启用开关**不会**加载新代码。

---

## 使用

**方式一：界面控件。** 输入框那一行（「工作区内修改」右侧、模型选择器左侧）会出现分段控件：

```
Chat  |  Web  |  Agent
```

当前模式高亮，点一下即切换。

**方式二：斜杠命令。**

```
/mode agent      # 完整能力
/mode webchat    # 能搜能读能记，不能改
/mode chat       # 纯文本
```

两种方式等价，都作用于**当前会话**。

---

## 实现要点

如果你也想写一个「给 DSH 加能力边界」的插件，这几点是我们踩出来的，可能替你省几个小时。

### 1. 三层防线，缺一不可

| 层 | API | 作用 |
|---|---|---|
| 工具过滤 | `agent.ctx.tools.restrict(filter)` | 从模型看到的工具表里裁掉 |
| 执行守卫 | `agent.ctx.tools.guard(fn)` | 执行前拦截，返回字符串即拒绝 |
| 提示词 | `system-prompt/assemble` 钩子 + 自定义 section | 裁剪工具 schema、注入行为约束 |

`guard` 是最后一道保险：即使 `restrict` 没生效（比如某类工具它管不到），调用仍会被拒。

### 2. ⭐ `restrict` 的 `allow` 与 `deny` 方向不同，会决定成败

契约原文：

> `restrict(filter)` — "Restrict **global tools** for the calling agent scope. Empty filters, unknown names, scope-local names, and reserved transport names fail. Restrictions intersect; **scoped registrations remain visible**."

关键在于：

- **`{ allow: [...] }` 隐含"裁掉一切未列出的"**。而 `ctx.tools.schemas()`（不带参数）只返回**全局视图**，由 agent preset 行注册的工具**不在其中** —— 于是你**没法把它们列进 `allow`**，它们就被**隐式裁掉**了。名字写进 `allow` 也没用：不在可见集里就传不进去，调用时直接报 `unknown tool`。
- **`{ deny: [...] }` 只禁"明确列出的"**。把 deny 名单算成「可见集里不在白名单中的那些」，白名单工具就**自动获得放行** —— 包括 `schemas()` 里看不见的那些。

**一句话：要"只允许白名单"，用 `deny` 反着写，比用 `allow` 正着写更可靠。**

### 3. 提示词必须播报"真实可用集"

模型是照着提示词规划下一步的。如果提示词里写着某工具可用、实际却被裁掉了，模型就会**反复尝试调用、反复被拒**，白白烧 token。

所以本插件在 system prompt 里**动态列出**当前会话真正的工具清单（从 host 侧记录的实际放行集生成），并明确告诉模型：

> 你的工具只有这些，其他工具在本模式下**并不存在** —— 不要尝试调用，也不要围绕它们做计划。

### 4. 客户端控件怎么挂

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'webchat-mode',
  order: 50,
  inject: (sessionId) => ({ /* 自定义 props */ }),
}, YourComponent));
```

- 只用**官方声明的槽位**，别去读别的插件的 DOM 来"估算位置"
- 组件会额外收到 `useProjection`
- 当前模式通过**会话投影**（`ctx.sessionProjections.register({...})`）暴露给界面，折叠规则与 host 内部判定**同源**，保证"显示的"和"生效的"永远一致
- 切换动作走 `sessions.binding(sessionId).session.command('/mode xxx')`，与手敲命令是同一条路径

### 5. `link:` 安装的本地包，依赖要从源目录解析

如果你用 `link:` 装本地插件，包内 `import 'zod'` 会报 `Cannot find package 'zod'` —— 即使 profile 的 `node_modules` 里已经有它（那是别的包自带的隔离依赖树）。

**解法**：在插件目录里自备依赖：

```bash
cd your-plugin
npm install zod --cache ./.npm-cache
```

（`--cache` 指向可写目录，避免被系统权限拦住。）

---

## 已知限制

- 仅针对 **DSH 桌面版 0.2.0-rc.2** 实测通过；其他版本 API 可能有变动。
- `chat` 模式用 `{ allow: [] }` 实现全禁（`deny` 需要穷举全集才等价，不划算）。
- 本插件不改动 DSH 自身的任何文件，只通过公开 API 施加限制。

---

## License

[MIT](./LICENSE)
