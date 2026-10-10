/**
 * webchat-mode 的浏览器半区：输入框工具行里的三段式模式切换控件。
 *
 * 位置：`conversation.input.left`（输入框工具行的左侧控件区，
 *       即「工作区内权限选择器」右边、模型选择器左边）。
 * 状态：读 host 注册的会话投影 `webchat-mode`（与 host 的 foldMode 同源）。
 * 切换：向本地 command 服务发 `/mode <agent|webchat|chat>`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webchat-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ORDER = ['chat', 'webchat', 'agent'];
    const LABELS = { chat: 'Chat', webchat: 'Web', agent: 'Agent' };
    const TITLES = {
      chat: 'Chat：纯对话，不调用任何工具（省 token）',
      webchat: 'Web：可联网搜索、可读工作区文件，但不改动任何东西',
      agent: 'Agent：完整能力（可改文件、跑命令、委派）'
    };

    const styles = {
      dock: {
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        flex: 'none'
      },
      root: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 26,
        padding: 2,
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1)',
        flex: 'none'
      },
      button: {
        minWidth: 44,
        height: 20,
        padding: '0 9px',
        border: 0,
        borderRadius: 999,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '20px',
        cursor: 'pointer',
        transition: 'background-color 120ms ease, color 120ms ease, opacity 120ms ease'
      },
      active: {
        background: 'var(--dsw-alias-interactive-bg-active)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600
      },
      pending: { opacity: 0.62, cursor: 'wait' },
      error: {
        marginLeft: 6,
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 11
      }
    };

    /** 三段式切换控件：Chat / Web / Agent。 */
    function ModeToggle({ useProjection, setMode }) {
      const projection = useProjection('webchat-mode');
      const [submitting, setSubmitting] = React.useState(null);
      const [error, setError] = React.useState(null);
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);

      if (projection === undefined) return null;
      const selected = projection.mode;

      const choose = (mode) => {
        if (mode === selected || submitting !== null) return;
        setSubmitting(mode);
        setError(null);
        setMode(mode).then(
          (failure) => {
            if (!alive.current) return;
            setSubmitting(null);
            setError(failure);
          },
          (reason) => {
            if (!alive.current) return;
            setSubmitting(null);
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        );
      };

      return h(
        'div',
        { style: styles.dock, 'data-webchat-mode-toggle': '' },
        h(
          'span',
          {
            style: styles.root,
            role: 'group',
            'aria-label': '会话模式',
            'aria-busy': submitting !== null
          },
          ORDER.map((mode) => {
            const active = selected === mode;
            return h(
              'button',
              {
                key: mode,
                type: 'button',
                style: {
                  ...styles.button,
                  ...(active ? styles.active : {}),
                  ...(submitting !== null ? styles.pending : {})
                },
                'aria-pressed': active,
                title: TITLES[mode],
                disabled: submitting !== null,
                onClick: () => choose(mode)
              },
              LABELS[mode]
            );
          })
        ),
        error !== null
          ? h('span', { style: styles.error, role: 'status', title: error }, '切换失败')
          : null
      );
    }

    const inject = ['slots', 'sessions'];

    function apply(ctx) {
      const sessions = ctx.sessions;
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'webchat-mode',
            order: 50,
            label: '会话模式',
            inject: (sessionId) => ({
              setMode: async (mode) => {
                const session = sessions.binding(sessionId)?.session;
                if (session === undefined) return '会话不可用';
                const result = await session.command(`/mode ${mode}`);
                if (!result.ok) return `${result.error.message} (${result.error.code})`;
                if (!result.value.matched) return '未知命令：/mode';
                return null;
              }
            })
          },
          ModeToggle
        )
      );
    }

    return { inject, apply };
  }
});
