/**
 * webchat-mode — 网页版式聊天模式（对照 DeepSeek 网页版免费聊天的能力边界）
 *
 * 三个模式，按会话切换：
 *   agent   （默认）完整能力，不做任何限制
 *   webchat 允许「联网搜索 + 查看工作区文件 + 提问/展示」，禁止一切改动操作
 *   chat    纯文本对话，零工具（给"只要一个答案、不想花 token"的场景）
 *
 * 三层防线：
 *   1. agent 作用域的工具过滤器 ctx.tools.restrict({ deny }) —— 用 deny 而不是 allow，
 *      原因见 syncRestriction 内的长注释（allow 会连带裁掉 schemas() 全局视图里看不见的工具）
 *   2. 执行守卫 ctx.tools.guard()，拦截漏网的调用
 *   3. system-prompt/assemble 钩子：裁剪工具 schema + 动态播报真实可用的工具清单
 *
 * 另外注册一个 sessionProjection（key = "webchat-mode"），供客户端控件显示当前模式。
 */
import { z } from "zod";

export const name = "webchat-mode";
export const inject = ["agents", "tools", "systemPrompt"];

/** 网页版式聊天允许的工具（联网 + 只读查看 + 交互）。 */
export const WEBCHAT_ALLOWED_TOOLS = Object.freeze([
  // 联网检索与抓取
  "web_search",
  "web_fetch",
  "research",
  "advanced_search",
  "multi_search",
  "platform_search",
  "video_search",
  "domain_search",
  "cache_search",
  // 查看工作区文件 / 图片
  "read",
  "glob",
  "grep",
  "read_image",
  // 交互
  "ask_user_question",
  "present",
  // 记忆与日历：写的是 DSH 自己的记忆目录（不是用户工作区文件），性质是记笔记，故在 Web 模式放行
  "memory_log",
  "memory_note",
  "memory_user",
  "memory_read",
  "memory_recall",
  "memory_status",
  "memory_reflect",
  "memory_external",
  "memory_rules",
  "memory_consolidate",
  "memory_maintain",
  "memory_procedure",
  "memory_procedure_list",
  "memory_expand",
  "memory_trace",
  "calendar_add",
  "calendar_list",
  "calendar_done",
  "calendar_remove"
]);

export const MODES = Object.freeze(["agent", "webchat", "chat"]);
export const PROJECTION_KEY = "webchat-mode";
export const DEFAULT_MODE = "agent";

export const WEBCHAT_GUIDANCE = [
  "You are in Web-chat mode: a deliberately minimal mode that ships with only a handful of tools.",
  "Start from the assumption that you have almost no tools - at most some search/read tools plus the ability to ask the user.",
  "Never attempt to call a tool that is not in your provided tool list.",
  "A missing tool is not a problem to work around and not an error to report: it simply does not exist in this mode, so do not plan around it.",
  "Prefer answering directly from what you already know, and reach for a tool only when it genuinely adds value.",
  "You may search the web and read workspace files, but you must not change anything:",
  "no creating, editing or deleting files, no running commands, no delegating, no third-party side effects.",
  "Exception: recording notes into your own memory and calendar (memory_* and calendar_* tools) IS allowed - that is note-taking, not modifying the user's project.",
  "Cite what you found.",
  "If the request requires making changes, say what should be done and ask the user to switch to Agent mode."
].join(" ");

export const CHAT_GUIDANCE = [
  "You are in Chat mode.",
  "Answer the user directly in text without using tools.",
  "If the request requires action, explain what should be done and ask the user to switch to Agent mode."
].join(" ");

const DENY_MESSAGES = {
  chat: "Chat mode does not allow tool execution. Switch this session to Agent mode to use tools.",
  webchat:
    "Web-chat mode allows searching the web and reading files, but not changing anything. Switch to Agent mode to make changes."
};

export function isMode(value) {
  return typeof value === "string" && MODES.includes(value);
}

/** 读一条命令事件里的模式参数（命令名固定为 `mode`）。 */
function commandMode(event) {
  if (event?.type !== "command/run") return undefined;
  if (event.data?.name !== "mode") return undefined;
  const raw = String(event.data.args ?? "").trim().toLowerCase();
  return isMode(raw) ? raw : undefined;
}

/** 兼容 rc 与 0.1.2 两代 Session API 的事件快照。 */
function sessionEvents(session) {
  const compatible = session;
  if (typeof compatible.snapshotEvents === "function") return compatible.snapshotEvents();
  return compatible.events ?? [];
}

/**
 * 从会话日志折叠出当前模式 —— 与 projection 同源，
 * 保证「host 实际行为」与「界面显示的状态」永远一致。
 */
export function foldMode(events, fallback = DEFAULT_MODE) {
  let mode = fallback;
  const attempts = new Map();
  for (const event of events ?? []) {
    if (event.type === "command/run") {
      const candidate = commandMode(event);
      if (candidate !== undefined) attempts.set(event.data.commandId, candidate);
      continue;
    }
    if (event.type !== "command/done") continue;
    const candidate = attempts.get(event.data.commandId);
    if (candidate === undefined) continue;
    attempts.delete(event.data.commandId);
    if (event.data.kind === "success") mode = candidate;
  }
  return mode;
}

export function apply(ctx, config) {
  const allowed = Array.isArray(config?.allowedTools) && config.allowedTools.length > 0
    ? config.allowedTools
    : WEBCHAT_ALLOWED_TOOLS;
  const defaultMode = isMode(config?.defaultMode) ? config.defaultMode : DEFAULT_MODE;
  const denyMessage = {
    chat: config?.chatDenyMessage ?? DENY_MESSAGES.chat,
    webchat: config?.webchatDenyMessage ?? DENY_MESSAGES.webchat
  };
  const guidance = {
    chat: config?.chatGuidance ?? CHAT_GUIDANCE,
    webchat: config?.webchatGuidance ?? WEBCHAT_GUIDANCE
  };

  /** session -> mode（本回合内的即时选择，先于事件落地生效） */
  const runtimeSelections = new WeakMap();
  const instrumented = new Map();
  const agentsBySession = new WeakMap();

  const modeOf = (agent) =>
    runtimeSelections.get(agent.session) ?? foldMode(sessionEvents(agent.session), defaultMode);

  // 全局视图：restrict 只作用于这一层。schemas() 不带 scope 时返回的就是全局工具集。
  const globalToolNames = (agent) => {
    try {
      return new Set(agent.ctx.tools.schemas().map((schema) => schema.name));
    } catch {
      return undefined;
    }
  };

  const syncRestriction = (agent) => {
    const state = instrumented.get(agent);
    if (state === undefined) return;
    const dispose = state.restriction;
    const mode = modeOf(agent);

    if (mode === "agent") {
      if (dispose !== undefined) {
        dispose();
        delete state.restriction;
      }
      delete state.restrictAllow;
      delete state.effectiveAllow;
      return;
    }

    const globalView = globalToolNames(agent);

    // 两种模式用两种 filter：
    //
    //  · chat    —— 全禁；只有 `allow: []` 能表达（deny 要穷举全集才等价，不划算）。
    //
    //  · webchat —— 用 `deny` 而不是 `allow`。
    //      allow 只能列「全局名」且每个都必须存在，而 schemas() 的全局视图里
    //      恰恰缺 read/grep/glob/read_image/web_search/web_fetch/ask_user_question/present
    //      这 8 个（实测：写进 allow 传不进去、调用报 unknown tool）。
    //      deny 只需列出「要禁的全局工具」，名字全部取自同一份全局视图，
    //      因此永远不会触发 "unknown names ... fail"；
    //      而那 8 个既然不在 deny 名单里，就自动获得放行机会。
    const denyList = globalView === undefined
      ? []
      : [...globalView].filter((toolName) => !allowed.includes(toolName));

    // 播报：deny 模式下不在 deny 名单里的都在白名单内，如实播报白名单。
    const report = mode === "chat" ? [] : allowed.slice();

    // 拿不到全局工具表时无法安全 restrict（可能把该禁的漏掉），交给 guard 兜底
    if (mode === "webchat" && globalView === undefined) return;

    const sameList = (a, b) =>
      a !== undefined && b !== undefined
      && a.length === b.length && a.every((toolName, index) => toolName === b[index]);
    const filterKey = mode === "chat" ? [] : denyList;

    // 工具表会随后续注册变化，所以每次重算；只有集合真的变了才重建过滤器。
    if (dispose !== undefined
      && sameList(state.restrictAllow, filterKey)
      && sameList(state.effectiveAllow, report)) {
      return;
    }

    if (dispose !== undefined) {
      dispose();
      delete state.restriction;
    }
    try {
      state.restriction = mode === "chat"
        ? agent.ctx.tools.restrict({ allow: [] })
        : agent.ctx.tools.restrict({ deny: denyList });
      state.restrictAllow = filterKey;
      state.effectiveAllow = report;
    } catch (cause) {
      state.restriction = undefined;
      state.restrictAllow = undefined;
      // 即便 restrict 失败也要如实播报可用工具（guard 仍在兜底拦截非白名单调用）
      state.effectiveAllow = report;
      ctx.logger?.warn?.(`webchat-mode: restrict failed: ${cause?.message ?? cause}`);
    }
  };

  const cleanupAgent = (agent) => {
    const state = instrumented.get(agent);
    if (state === undefined) return;
    instrumented.delete(agent);
    agentsBySession.delete(agent.session);
    try { state.restriction?.(); } catch {}
    try { state.prompt?.(); } catch {}
    try { state.guard?.(); } catch {}
  };

  const instrument = (agent) => {
    if (instrumented.has(agent)) return;
    const state = {};
    instrumented.set(agent, state);
    agentsBySession.set(agent.session, agent);
    try {
      state.guard = agent.ctx.tools.guard((execution) => {
        const mode = modeOf(agent);
        if (mode === "agent") return undefined;
        if (mode === "webchat" && allowed.includes(execution.name)) return undefined;
        return denyMessage[mode];
      });

      state.prompt = agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const assembly = await next();
        const mode = modeOf(agent);
        if (mode === "agent") return assembly;
        const keep = mode === "webchat" ? new Set(state.effectiveAllow ?? allowed) : new Set();
        return {
          ...assembly,
          sections: (assembly.sections ?? []).filter(
            (section) => section.name !== "tools:sdk" && section.name !== "tools:code-only"
          ),
          tools: (assembly.tools ?? []).filter((tool) => keep.has(tool.name))
        };
      });

      syncRestriction(agent);
    } catch (cause) {
      cleanupAgent(agent);
      throw cause;
    }
  };

  ctx.on("agent/created", ({ agent }) => instrument(agent));
  ctx.on("agent/disposed", ({ agent }) => cleanupAgent(agent));
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal?.aborted) return decision;
    instrument(agent);
    syncRestriction(agent);
    return decision;
  });

  ctx.effect(() => () => {
    for (const agent of [...instrumented.keys()]) cleanupAgent(agent);
  }, "webchat-mode: agent instrumentation");

  ctx.systemPrompt.section({
    name: "webchat-mode:guidance",
    order: 41,
    text: (context) => {
      const agent = context.agent;
      if (agent === undefined) return "";
      const mode = modeOf(agent);
      if (mode === "agent") return "";
      if (mode === "chat") return guidance.chat;
      const state = instrumented.get(agent);
      const list = state?.effectiveAllow ?? [];
      const roster = list.length > 0
        ? "Your ONLY tools in this session are: " + list.join(", ") + ". No other tool exists here - do not attempt to call one or assume any other capability."
        : "You have no tools in this session; answer from what you already know.";
      return guidance.webchat + " " + roster;
    }
  });

  // 会话投影：客户端控件靠它显示当前模式（与 foldMode 同一套折叠规则）
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    const modeSchema = z.enum(["agent", "webchat", "chat"]);
    projectionCtx.sessionProjections.register({
      key: PROJECTION_KEY,
      schema: z.object({ mode: modeSchema }),
      stateSchema: z.object({
        mode: modeSchema,
        attempts: z.array(z.object({ commandId: z.string(), mode: modeSchema }))
      }),
      init: () => ({ mode: defaultMode, attempts: [] }),
      apply: (state, event) => {
        if (event.type === "command/run") {
          const mode = commandMode(event);
          if (mode === undefined) return state;
          return {
            ...state,
            attempts: [...state.attempts, { commandId: event.data.commandId, mode }]
          };
        }
        if (event.type !== "command/done") return state;
        const attempt = state.attempts.find((candidate) => candidate.commandId === event.data.commandId);
        if (attempt === undefined) return state;
        const attempts = state.attempts.filter((candidate) => candidate !== attempt);
        if (event.data.kind !== "success") return { ...state, attempts };
        return { mode: attempt.mode, attempts };
      },
      view: (state) => ({ mode: state.mode }),
      wire: {
        viewSchema: z.object({ mode: modeSchema }),
        view: (state) => ({ mode: state.mode })
      },
      stateVersion: 1
    });
  });

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "mode",
      description: "Switch this session between Agent / Web-chat / Chat mode",
      input: { hint: "<agent|webchat|chat>" },
      handler: ({ agent, rawInput }) => {
        const requested = String(rawInput ?? "").trim().toLowerCase();
        if (!isMode(requested)) {
          return { kind: "error", text: "Usage: /mode <agent|webchat|chat>" };
        }
        instrument(agent);
        const previous = modeOf(agent);
        runtimeSelections.set(agent.session, requested);
        try {
          syncRestriction(agent);
        } catch (cause) {
          runtimeSelections.set(agent.session, previous);
          syncRestriction(agent);
          throw cause;
        }
        if (requested === "webchat") {
          return {
            kind: "success",
            text: "Web-chat mode selected. Web search and file reading are available; any change is blocked. Switch back with /mode agent."
          };
        }
        if (requested === "chat") {
          return {
            kind: "success",
            text: "Chat mode selected. Tool calls are blocked. Switch back with /mode agent."
          };
        }
        return { kind: "success", text: "Agent mode selected. Full tool access is restored." };
      }
    });
  });

  for (const agent of ctx.agents.list()) instrument(agent);
}

// Cordis 从 apply 函数对象上读取 inject（不是模块的 named export）。
// 只写 `export const inject` 会在激活时报：
//   cannot get property "systemPrompt" without inject
// 注意：只能挂 inject —— 函数的 `name` 属性是只读的，把它一起 assign 会抛
//   Cannot assign to read only property 'name' of function
Object.assign(apply, { inject });

export default apply;
