// The remaining Doubao credit, beside the composer.
//
// Mirrors what the WorkBuddy plugin does for its own accounts: the readout sits
// in `conversation.input.right`, so it is only as far from the send button as
// the model name is. The number itself cannot be computed here — it is an
// upstream fact — so the component asks the host's own route
// (`/plugins/dsh-plugin-doubao/credits`, registered by lib/index.js) and shows
// an em dash when that read fails. A dash is the honest rendering of "could not
// read it", which is a different fact from "you have none left".
//
// Every hook runs before the provider test, because the slot renders for every
// provider: the readout is drawn for `doubao` rows only, but bailing out before
// the hooks would break React's ordering the moment the user switches models.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-doubao',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PROVIDER_ID = 'doubao'
    const CREDITS_PATH = '/plugins/dsh-plugin-doubao/credits'
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

    /** One line per quota group, for the tooltip: what the total is made of. */
    function describe(credits) {
      if (!credits) return undefined
      const rows = (credits.groups ?? []).map(
        (group) => `${group.label} ${formatAmount(group.remaining)} / ${formatAmount(group.limit)}`,
      )
      if (rows.length === 0) rows.push(`${formatAmount(credits.remaining)} / ${formatAmount(credits.limit)}`)
      return rows.join(' · ')
    }

    async function readCredits(signal) {
      const response = await fetch(CREDITS_PATH, { headers: { Accept: 'application/json' }, signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`credits read returned HTTP ${response.status}`)
      const payload = await response.json()
      return payload?.credits ?? null
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

    const zh = {
      label: '积分',
      failed: '无法读取豆包剩余积分',
    }
    const en = {
      label: 'Credits',
      failed: 'Could not read the Doubao credit balance',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const namespace = 'doubaoCredits'
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshPluginDoubaoCredits = ''
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'doubao: credits styles')
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'doubao: credits dictionaries')
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'dsh-plugin-doubao-credits',
              order: 4,
              locale: namespace,
            },
            CreditsPill,
          ),
        )
      },
    }
  },
})
