// Two browser components beside the composer:
//   1. the remaining Doubao credit readout (only shown for doubao rows)
//   2. a permanent "Doubao sign in" button that opens a QR modal inside DSH,
//      so a new user never has to hunt for a file or a terminal.
//
// The credit number is an upstream fact, and so is the sign-in state. Both are
// read from the host's own loopback routes registered in lib/index.js:
//   /plugins/dsh-plugin-doubao/credits
//   /plugins/dsh-plugin-doubao/status | /login-state | /login-start
// A fetch failure renders an honest dash / "unknown", never a fake zero.
//
// Every hook runs before any provider test — the slots render for every provider,
// and bailing early would break React's hook ordering when the user switches models.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-doubao',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PROVIDER_ID = 'doubao'
    const CREDITS_PATH = '/plugins/dsh-plugin-doubao/credits'
    const STATUS_PATH = '/plugins/dsh-plugin-doubao/status'
    const LOGIN_STATE_PATH = '/plugins/dsh-plugin-doubao/login-state'
    const LOGIN_START_PATH = '/plugins/dsh-plugin-doubao/login-start'
    /** How often an open composer re-reads the balance. */
    const REFRESH_MS = 60_000

    const CSS = `
.dsh-doubao-credits{display:inline-flex;align-items:center;min-width:0}
.dsh-doubao-credits-trigger{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;
  padding:2px 6px;border:0;border-radius:6px;background:transparent;
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;cursor:pointer;
  font-variant-numeric:tabular-nums;
}
.dsh-doubao-credits-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-doubao-credits-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}

.dsh-doubao-signin-trigger{
  appearance:none;display:inline-flex;align-items:center;gap:4px;
  padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  border-radius:6px;background:transparent;
  font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#bbb);
}
.dsh-doubao-signin-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-doubao-signin-dot{width:6px;height:6px;border-radius:50%;background:#9aa0a6;flex:none}
.dsh-doubao-signin-dot.ok{background:#34c759}

.dsh-doubao-modal-backdrop{
  position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.55);padding:20px;
}
/* The modal carries its own palette instead of borrowing DSH theme tokens.
   A missing token silently falls back to the second argument, so a light UI
   with a dark-theme guess (near-white text on a near-white panel) rendered a
   blank white box. These literals look the same in light and dark themes. */
.dsh-doubao-modal{
  position:relative;width:min(420px,100%);max-height:90vh;overflow:auto;
  background:#1b2029;color:#eef1f5;color-scheme:dark;
  border:1px solid #39414f;border-radius:14px;
  box-shadow:0 24px 70px rgba(0,0,0,.55);padding:22px 24px 20px;
  font-family:system-ui,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;
  text-align:left;
}
.dsh-doubao-modal *{box-sizing:border-box}
.dsh-doubao-modal h3{margin:0 24px 6px 0;font-size:16px;font-weight:600;color:#ffffff}
.dsh-doubao-modal p{margin:0 0 12px;font-size:12px;color:#a9b2c0;line-height:1.6}
.dsh-doubao-modal-close{
  position:absolute;top:8px;right:10px;appearance:none;border:0;background:transparent;
  font-size:20px;line-height:1;cursor:pointer;color:#a9b2c0;padding:2px 6px;border-radius:6px;
}
.dsh-doubao-modal-close:hover{color:#ffffff;background:rgba(255,255,255,.1)}
.dsh-doubao-qr{
  display:block;width:240px;height:240px;margin:6px auto 10px;padding:8px;
  background:#ffffff;border-radius:10px;object-fit:contain;
}
.dsh-doubao-qr-placeholder{
  display:flex;align-items:center;justify-content:center;width:240px;height:240px;
  margin:6px auto 10px;border-radius:10px;background:#252c38;border:1px dashed #39414f;
  color:#c3cad6;font-size:12px;text-align:center;padding:16px;line-height:1.6;
}
.dsh-doubao-status{margin:8px 0;text-align:center;font-size:13px;min-height:18px;color:#dfe4ec}
.dsh-doubao-status.ok{color:#4ade80}
.dsh-doubao-status.bad{color:#f87171}
.dsh-doubao-verdict{
  margin-top:8px;font-size:11px;line-height:1.5;word-break:break-all;color:#9aa4b2;
  max-height:88px;overflow:auto;
}
.dsh-doubao-verdict.ok{color:#4ade80}
.dsh-doubao-actions{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap}
.dsh-doubao-btn{
  appearance:none;border:1px solid #4a5361;border-radius:7px;background:#252c38;
  color:#eef1f5;padding:6px 14px;font-size:12px;line-height:18px;cursor:pointer;
  font-family:inherit;
}
.dsh-doubao-btn:hover{background:#2f3745}
.dsh-doubao-btn:disabled{opacity:.55;cursor:default}
.dsh-doubao-btn.primary{background:#2f6df6;border-color:#2f6df6;color:#ffffff}
.dsh-doubao-btn.primary:hover{background:#3d7bff}
`

    /** The provider the session is pointing at, or undefined before one is picked. */
    function providerOf(projection) {
      const provider = (projection?.next ?? projection?.lastUsed)?.provider
      return typeof provider === 'string' && provider !== '' ? provider : undefined
    }

    /** `9,793` — the same thousand-separated spelling the official client uses. */
    function formatAmount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return Math.round(value).toLocaleString('en-US')
    }

    function describe(credits) {
      if (!credits) return undefined
      const rows = (credits.groups ?? []).map(
        (group) => `${group.label} ${formatAmount(group.remaining)} / ${formatAmount(group.limit)}`,
      )
      if (rows.length === 0) rows.push(`${formatAmount(credits.remaining)} / ${formatAmount(credits.limit)}`)
      return rows.join(' · ')
    }

    async function getJson(path, options) {
      const response = await fetch(path, {
        headers: { Accept: 'application/json', ...(options?.body ? { 'Content-Type': 'application/json' } : {}) },
        cache: 'no-store',
        ...options,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function readCredits(signal) {
      const payload = await getJson(CREDITS_PATH, { signal })
      return payload?.credits ?? null
    }

    const STATUS_LABELS = {
      idle: 'start',
      init: 'starting',
      new: 'waiting',
      scanned: 'scanned',
      confirmed: 'done',
      expired: 'expired',
      timeout: 'expired',
      error: 'error',
    }

    function CreditsPill(props) {
      const { t, useProjection } = props
      const projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
      const provider = providerOf(projection)
      const owned = provider === PROVIDER_ID
      const [credits, setCredits] = React.useState(undefined)
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        if (!owned) return undefined
        let alive = true
        let timer
        const read = async () => {
          try {
            const next = await readCredits()
            if (!alive) return
            setCredits(next)
            setFailed(false)
          } catch {
            if (!alive) return
            setFailed(true)
          }
        }
        read()
        timer = setInterval(read, REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [owned])

      if (!owned) return null

      const label = t === undefined ? '积分' : t('label')
      const text =
        credits === undefined
          ? `${label} …`
          : credits === null
            ? `${label} —`
            : `${label} ${formatAmount(credits.remaining)}`
      const title = failed
        ? t === undefined ? '无法读取豆包剩余积分' : t('failed')
        : describe(credits)

      return h(
        'div',
        { className: 'dsh-doubao-credits' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-doubao-credits-trigger',
            title,
            onClick: async () => {
              try {
                const next = await readCredits()
                setCredits(next)
                setFailed(false)
              } catch {
                setFailed(true)
              }
            },
          },
          text,
        ),
      )
    }

    /** The QR modal. Polls the shared host route while open. */
    function SignInModal({ t, onClose, onSignedIn }) {
      const [state, setState] = React.useState({ status: 'idle', png: '', at: 0, hint: '', verdict: '' })
      const [busy, setBusy] = React.useState(false)

      const start = React.useCallback(async (force) => {
        setBusy(true)
        try {
          const next = await getJson(LOGIN_START_PATH, {
            method: 'POST',
            body: JSON.stringify({ force }),
          })
          // The host answers 200 even when it could not start a server; the
          // reason is in `error`. Without this branch the click looked dead.
          if (typeof next?.error === 'string' && next.error !== '') {
            setState((prev) => ({ ...prev, status: 'error', verdict: next.error, at: Date.now() }))
            return
          }
          setState((prev) => ({ ...prev, status: next?.started === false ? 'signed-in' : 'new', at: Date.now() }))
        } catch (error) {
          // A failed fetch used to reject out of this function with nothing on
          // screen — the exact "clicked sign in, nothing happened" report.
          setState((prev) => ({
            ...prev,
            status: 'error',
            verdict: error?.message ?? String(error),
            at: Date.now(),
          }))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let kicked = false
        const poll = async () => {
          try {
            // An account that is already connected must never see a QR. The
            // /status route knows the truth; when it says signed-in, stop here
            // before touching /login-state — that route reports `idle` (no
            // server is running) and would otherwise kick a pointless QR
            // issuer, which is exactly what made a signed-in user see the
            // "generating code…" placeholder forever.
            const status = await getJson(STATUS_PATH)
            if (!alive) return
            if (status.signedIn) {
              setState((prev) => ({ ...prev, status: 'signed-in', png: '' }))
              return
            }
            const next = await getJson(LOGIN_STATE_PATH)
            if (!alive) return
            setState(next)
            if (typeof next.verdict === 'string' && next.verdict.includes('saved')) onSignedIn?.()
            // A freshly opened modal has no login server yet, so /login-state
            // reports `idle` with no image. Kick the issuer once so the code
            // appears without the user having to press "Show QR code" first —
            // that second click is exactly what felt like "no reaction".
            if (!kicked && !next.png && next.status !== 'signed-in') {
              kicked = true
              start(false)
            }
          } catch {
            /* keep the last known state; the route may still be starting */
          }
        }
        poll()
        const timer = setInterval(poll, 1200)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [onSignedIn, start])

      const saved = typeof state.verdict === 'string' && state.verdict.includes('saved')
      const statusText = (() => {
        if (state.status === 'signed-in') return t ? t('alreadyIn') : 'Already signed in'
        if (saved) return t ? t('done') : 'Signed in — you can close this window'
        const key = STATUS_LABELS[state.status]
        return key && t ? t(key) : state.status
      })()
      const statusClass = saved || state.status === 'signed-in' ? ' ok' : state.status.startsWith('error') ? ' bad' : ''

      return h(
        'div',
        { className: 'dsh-doubao-modal-backdrop', onClick: onClose },
        h(
          'div',
          { className: 'dsh-doubao-modal', onClick: (e) => e.stopPropagation() },
          h('button', { type: 'button', className: 'dsh-doubao-modal-close', onClick: onClose, title: '×' }, '×'),
          h('h3', null, t ? t('modalTitle') : 'Sign in to Doubao'),
          h('p', null, t ? t('modalHint') : 'Open the Douyin app on your phone and scan the code below. Scanning with the Doubao app will not work.'),
          state.png
            ? h('img', { className: 'dsh-doubao-qr', src: 'data:image/png;base64,' + state.png, alt: 'QR code' })
            : h(
                'div',
                { className: 'dsh-doubao-qr-placeholder' },
                state.status === 'signed-in' ? (t ? t('alreadyInBody') : 'Your account is already connected.') : t ? t('loading') : 'Generating code…',
              ),
          h('div', { className: 'dsh-doubao-status' + statusClass }, statusText || ''),
          state.hint ? h('div', { className: 'dsh-doubao-verdict' }, state.hint) : null,
          state.verdict ? h('div', { className: 'dsh-doubao-verdict' + (saved ? ' ok' : '') }, state.verdict) : null,
          h(
            'div',
            { className: 'dsh-doubao-actions' },
            h(
              'button',
              { type: 'button', className: 'dsh-doubao-btn primary', disabled: busy, onClick: () => start(false) },
              t ? t('scan') : 'Show QR code',
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-doubao-btn', disabled: busy, onClick: () => start(true) },
              t ? t('rescan') : 'Re-scan (force)',
            ),
            h('button', { type: 'button', className: 'dsh-doubao-btn', onClick: onClose }, t ? t('close') : 'Close'),
          ),
        ),
      )
    }

    /** A small permanent button, always visible, that opens the QR modal. */
    function SignInButton(props) {
      const { t } = props
      const [signedIn, setSignedIn] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await getJson(STATUS_PATH)
          setSignedIn(Boolean(payload?.signedIn))
        } catch {
          setSignedIn(false)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const run = async () => {
          try {
            const payload = await getJson(STATUS_PATH)
            if (alive) setSignedIn(Boolean(payload?.signedIn))
          } catch {
            if (alive) setSignedIn(false)
          }
        }
        run()
        const timer = setInterval(run, 30_000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const label =
        signedIn === undefined
          ? t ? t('checking') : 'Doubao…'
          : signedIn
            ? t ? t('signedIn') : 'Doubao signed in'
            : t ? t('signIn') : 'Doubao sign in'

      return h(
        React.Fragment,
        null,
        h(
          'button',
          { type: 'button', className: 'dsh-doubao-signin-trigger', onClick: () => setOpen(true), title: label },
          h('span', { className: 'dsh-doubao-signin-dot' + (signedIn ? ' ok' : '') }),
          label,
        ),
        open
          ? h(SignInModal, { t, onClose: () => setOpen(false), onSignedIn: refresh })
          : null,
      )
    }

    const zh = {
      label: '积分',
      failed: '无法读取豆包剩余积分',
      signIn: '豆包登录',
      signedIn: '豆包已登录',
      checking: '豆包…',
      modalTitle: '登录豆包',
      modalHint: '用手机上的抖音 App 扫描下方二维码。用豆包 App 扫码无效。',
      start: '准备中…',
      starting: '正在生成二维码…',
      waiting: '等待扫码',
      scanned: '已扫描，请在手机上确认',
      done: '登录成功，可以关闭了',
      expired: '二维码已过期，请重新获取',
      error: '出错了，请点「重新扫码」再试一次',
      alreadyIn: '已经登录',
      alreadyInBody: '账号已连接，无需重复登录。',
      loading: '正在生成二维码…',
      scan: '显示二维码',
      rescan: '重新扫码',
      close: '关闭',
    }
    const en = {
      label: 'Credits',
      failed: 'Could not read the Doubao credit balance',
      signIn: 'Doubao sign in',
      signedIn: 'Doubao signed in',
      checking: 'Doubao…',
      modalTitle: 'Sign in to Doubao',
      modalHint: 'Open the Douyin app on your phone and scan the code below. Scanning with the Doubao app will not work.',
      start: 'starting…',
      starting: 'Generating code…',
      waiting: 'waiting for scan',
      scanned: 'scanned — confirm on your phone',
      done: 'Signed in — you can close this window',
      expired: 'code expired — request a new one',
      error: 'Something went wrong — press "Re-scan" to try again',
      alreadyIn: 'Already signed in',
      alreadyInBody: 'Your account is already connected.',
      loading: 'Generating code…',
      scan: 'Show QR code',
      rescan: 'Re-scan (force)',
      close: 'Close',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const namespace = 'doubaoUi'
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshPluginDoubao = ''
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'doubao: styles')
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'doubao: dictionaries')
        const injectPill = ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-plugin-doubao-credits', order: 4, locale: namespace },
            CreditsPill,
          ),
        )
        const injectSignIn = ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-plugin-doubao-signin', order: 5, locale: namespace },
            SignInButton,
          ),
        )
        return () => {
          injectPill?.()
          injectSignIn?.()
        }
      },
    }
  },
})
