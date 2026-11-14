# dsh-plugin-doubao

Use Doubao (豆包) models inside [DSH](https://github.com/deepseek-ai/deepseek-harness) as a normal
provider. Install the plugin, sign in once by scanning a QR code with the Douyin app, then pick a
`doubao/*` model in the picker.

There is no proxy to start and no browser to drive. The plugin speaks the same HTTP endpoints the
web client uses, from inside the harness process.

Every model the client can route to is exposed, with the same names the client shows:

```
doubao                      Doubao
doubao-expert               Doubao Expert
doubao-auto                 Doubao Auto
doubao-2.1-lite             Doubao 2.1 Lite
doubao-2.1-pro              Doubao 2.1 Pro
deepseek-v4.1-flash         DeepSeek V4.1 Flash
deepseek-v4-pro             DeepSeek V4 Pro
kimi-k3.1-pro               Kimi K3.1 Pro
kimi-k3.1-pro-highspeed     Kimi K3.1 Pro Highspeed
kimi-k3                      Kimi K3
glm-5.3                     GLM 5.3
glm-5.3-flash               GLM 5.3 Flash
```

Picking one is not just a name. The client sends a five-tuple — `model_item_key`, `mode_id`,
`agent_mode`, `conversation_mode`, `reasoning_effort` (plus a thinking-mode id) — and repeats it in
three places in the request body. The server reads whichever copy it wants, so a field left at the
default silently answers from the plain chat model instead of the one you picked. All twelve are
verified against a live account.

### Credit multipliers

Like the WorkBuddy provider, each model name carries its credit multiplier on the right, separated
by a middle dot — `Doubao 2.1 Pro · x0.65`, `Kimi K3.1 Pro Highspeed · x1.44`. Promo tags ride
along too (`x0.01 限时优惠`, `小额免费`). The suffix goes on `name` rather than `description`
because DSH's model seat and `/model` popup render only `name`; routing still uses `id`, so this is
display-only and cannot change which model answers.

The table is read live from the client's `action_bar_v3/brief_list` endpoint at most once every ten
minutes, with a snapshot from 2026-11-14 as the seed so the picker is informative even before the
first lookup (or if it fails). A failed lookup returns "nothing new" instead of restoring the seed,
so a fresher rate is never rolled back to an older one. `Doubao` and `Doubao Expert` have no tag in
the client's own list and are shown without a suffix.

## Install

Straight from this repository — no npm release needed, since `pnpm` resolves a git URL directly:

```bash
dsh plugin --profile web add github:<owner>/dsh-plugin-doubao
npx dsh-plugin-doubao login
```

Replace `<owner>` with the account that hosts this repo. Restart DSH, then choose a Doubao model.
The login step is only needed once; the session is cached in `~/.dsh/doubao-local/credentials.json`.

If your DSH profile is the desktop app's, `dsh plugin` refuses to touch it (the Electron app owns
that profile). Add the dependency to the profile's `package.json` by hand and run `pnpm install`
there instead:

```json
"dsh-plugin-doubao": "github:<owner>/dsh-plugin-doubao"
```

and add `"dsh-plugin-doubao"` to `dsh.profile.bundles` in the same file.

## Sign in

`npx dsh-plugin-doubao login` prints a URL, serves a QR code there, and exits once you have scanned it.

**Scan with the Douyin app (抖音), not the Doubao app.** Doubao's own sign-in page says this, and
scanning with Doubao simply fails with no useful error.

Inside a running DSH session you can also just ask the agent to call the `doubao` service, or open
`http://127.0.0.1:8899/` after starting login.

## One thing you should know before installing

Doubao checks a device fingerprint on every request, and it only accepts the fingerprint of a device
the account has already used. Two failure modes follow from that, and they look alike:

| What was sent | What comes back |
| --- | --- |
| a valid session, but a device id the account has never seen | `710022004` — "rate limited" (it is not a rate limit) |
| no session at all | `710012001` — login invalid |

A freshly generated device id is refused no matter how valid the session is. So the plugin reads the
device id out of the **installed Doubao desktop client's** `Local State` file, and pairs it with the
session from your scan. That means:

- **The Doubao desktop client must be installed and signed in at least once** on the same machine.
  The plugin never launches it, never drives it, and works fine while it is closed — it only reads a
  JSON file. But without it there is no device id to use.
- Signing in on a different machine than the one that runs DSH will not work; run `login` where DSH
  runs.

`login` tells you straight away if no client identity is found, and lists the directories it looked in.

## Why not read the cookies from the client too?

Two reasons. The client's Cookies database is exclusively locked while it runs (SQLite cannot open it
even read-only), and it is encrypted with DPAPI. `Local State` and Local Storage, by contrast, are
plain files that stay readable — so only that half is read.

The leveldb directory is a *fallback*, not the primary source: leveldb blocks are prefix-compressed,
so once the client compacts its database `client_device_info` is no longer a contiguous byte run and
a scan finds nothing. `Local State` survives that compaction, so it wins when both are available.

## Configuration

All optional. Set them in the profile's `cordis.patch.yml` entry for `dsh-plugin-doubao`:

| Key | Default | What it does |
| --- | --- | --- |
| `providerId` | `doubao` | Provider id shown to the harness. Change it if another plugin already claims `doubao`. |
| `displayName` | `Doubao` | Name shown in the picker. |
| `minIntervalMs` | `6000` | Minimum gap between turns. Turns are serialized and spaced; see below. |
| `credentialsPath` | `~/.dsh/doubao-local/credentials.json` | Where the session is cached. |
| `loginPort` | `8899` | Port for the QR page served inside a session. |

Environment: `DOUBAO_CREDENTIALS` overrides the credential path, `DOUBAO_LOGIN_PORT` the login port,
`DSH_HOME` the base directory.

## Rate limiting

Doubao's risk engine reacts to bursts, not volume. Five quick calls in a row were enough to earn a
cooldown that outlasted the run producing them. So the plugin holds an exclusive lock for the whole
turn — request *and* stream — and keeps at least `minIntervalMs` between turns. Releasing the lock
after the POST is not enough: overlapping streams are exactly the pattern that trips `710022004`.

When a refusal does arrive, the adapter backs off for a minute and reports it as an error finish with
code `RATE_LIMIT`. It deliberately does not throw: a thrown error makes the harness retry, and
retrying a rate limit only deepens it. The provider also ships its own retry policy
(`RETRY_POLICY`) with `RATE_LIMIT` removed from `retryableCodes` — the harness default *would* retry
it five times, which is the opposite of what a flagged account needs.

Signing in does not clear a flag that is already set. If the account is flagged, the desktop client
shows a picture-selection captcha the next time you send a message from it, and solving it is what
restores access; the flag is account-wide, so the plugin recovers as soon as it is cleared. Note that
the captcha also expires quickly — a challenge that sits unsolved for a minute or two comes back as
`NotFoundChallengeId` and a fresh question, so the desktop client may need a restart before a slow
solve can succeed.

## Limitations

- **Text only.** Doubao's web endpoint accepts no images here, so nothing advertises image input.
- **No tool calling.** The harness tool loop needs a tool-call protocol this endpoint does not speak;
  the plugin flattens the conversation into a single prompt instead.
- **Token counts are estimates.** The endpoint returns no usage block, so counts are derived from
  character length (roughly two characters per token). Good enough for a meter, not for billing.
- **The thinking toggle only reaches the chat models.** `doubao` and `doubao-expert` take a
  `need_deep_think` flag, so the harness reasoning setting applies to them. For the routed models the
  thinking depth is part of the model definition — `GLM 5.3` is not `GLM 5.3` with thinking off — so
  the flag is fixed and the reasoning selector does nothing.
- **No conversation continuity.** Each turn is a fresh conversation on Doubao's side, because the
  endpoint is stateless per request and passing a conversation id back would require server-side state
  the harness does not give the adapter.

## Development

```bash
node --test test/plugin.test.mjs    # protocol, framing, pacer, identity, credentials
node --test test/apply.test.mjs     # wiring into a cordis context
```

Pass the file, not the directory: `node --test test/` is treated as a module path and fails with
`Cannot find module`.

The identity reader can be checked against the real client on this machine:

```bash
node -e "import('./lib/identity.js').then(m => console.log(m.toIdentity(m.findClientIdentity({}).info)))"
```

## Layout

| File | Role |
| --- | --- |
| `lib/doubao.js` | The wire protocol: query/body shaping, SSE framing, the turn pacer. |
| `lib/identity.js` | Reads `device_id` and friends out of the installed client's `Local State`. |
| `lib/adapter.js` | The LLM provider: model catalog, stream mapping, error mapping. |
| `lib/rates.js` | Reads the credit multipliers from Doubao's model-list endpoint. |
| `lib/login.js` | QR sign-in page, cookie harvest, credential storage. |
| `lib/index.js` | `apply()`: registers the provider and the `doubao` service. |
| `bin/login.js` | The `dsh-plugin-doubao` command. |

## Legal

This uses your own Doubao account through the same endpoints its web client calls. It is not
affiliated with ByteDance. Automating a consumer account may violate the service's terms, and the
account is yours to risk.
