# opencode-github-copilot-auto-model

Adds `github-copilot/auto` to opencode and can also inject additional configured
Copilot auto models. True Copilot auto-session routing is currently known to work
for the Claude and GPT/Codex families. Other listed Copilot models, such as
Gemini, are best-effort and may fall back to configured model selection rather
than full Copilot auto-session behavior.

GitHub Copilot's `auto` ID isn't accepted by the chat API directly; "auto" is a
client-side concept backed by two server endpoints. This plugin drives them from
opencode and adds the model to the picker as **`Auto`** plus any configured
extra autos such as **`Auto Claude`** or **`Auto GPT/Codex`**.

> **What the UI shows:** the picker and status bar read **`Auto`** (static label;
> the per-turn routing decision is surfaced as a transient toast — e.g.
> `Auto → gpt-5.4 · needs_reasoning`). The log has full detail
> (`chat.params override auto -> …`).

## Install

Add the package name to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "opencode-github-copilot-auto-model"
  ]
}
```

opencode will install it automatically from npm on first run.

> **Why not `github:m0wer/...`?** opencode installs `github:` plugins by having
> npm's arborist git-clone the repo on startup. That clone takes ~4s, but
> short-lived invocations (e.g. `opencode models`) dispose the instance before it
> finishes, so arborist rolls back the partial install and the cache is left empty
> on every launch. An npm tarball install has no clone and loads reliably.

Optional configuration (all settings are optional; Copilot session + intent routing
always runs regardless):

```jsonc
{
  "plugin": [
    [
      "opencode-github-copilot-auto-model",
      {
        // Ordered list of preferred models; first match in the session pool wins.
        // Accepts model keys (e.g. "claude-sonnet-4.6") or API ids.
        // Sets the endpoint anchor and routing fallback.
        "preferredModels": ["claude-sonnet-4.6", "gpt-5.3-codex"],

        // Per-label preferences: steer candidate selection per routing verdict.
        // Only models in the same endpoint family as the anchor are usable
        // (see "Within-family constraint"). Cross-family entries are skipped.
        "reasoning": ["claude-sonnet-4.6", "gpt-5.3-codex"],
        "noReasoning": ["gpt-5.3-codex", "claude-sonnet-4.6"],

        // Additional picker autos, all from this one plugin instance.
        // `name` and `id` are optional; the plugin derives them when omitted.
        "autos": [
          {
            "preferredModels": ["claude-sonnet-4.6", "claude-haiku-4.5"]
          },
          {
            "name": "Auto GPT/Codex",
            "preferredModels": ["gpt-5.4", "gpt-5.4-mini"]
          },
          {
            // Limited/best-effort: see "Gemini and other non-session models".
            "name": "Auto Gemini",
            "preferredModels": ["gemini-3.1-pro-preview", "gemini-3.5-flash"]
          }
        ]
      }
    ]
  ]
}
```

Options summary:

| Option | Type | Description |
|--------|------|-------------|
| `preferredModels` | string[] | Ordered fallback list; first pool match sets the anchor and default model. |
| `reasoning` | string[] | Preferred model(s) when the intent router returns `needs_reasoning`. |
| `noReasoning` | string[] | Preferred model(s) when the intent router returns `no_reasoning`. |
| `autos` | object[] | Additional injected autos from the same plugin instance. Each entry can set `id`, `name`, `preferredModels`, `reasoning`, and `noReasoning`. |

`autos` lets you expose multiple family-scoped Copilot autos from one plugin entry,
for example a Claude auto and a GPT auto at the same time. Repeating the same npm
plugin entry in `opencode.json` is not required. Treat Claude and GPT/Codex as the
primary supported families; Gemini and other non-session families are limited.

> **On cross-family preferences (e.g. claude-sonnet-4.6 for reasoning, gpt-5.3-codex
> for noReasoning):** the routing label is independent of model family — the intent
> router ranks both Claude and GPT models in a single list. However, the plugin has
> one fixed endpoint per session (the anchor family), so a cross-family preference
> entry is silently skipped and the best same-family candidate is used instead.
> A cross-family split (Claude for reasoning, GPT for fast) requires separate
> autos in the picker or a request proxy. This plugin now supports the former via
> the `autos` option.

## How it works

### Copilot auto: the two server calls

Copilot "auto" is backed by two calls on `https://api.githubcopilot.com`:

1. **`POST /models/session`** — opens an auto session: returns the candidate model
   pool (`available_models`) and a `Copilot-Session-Token`. Forwarding that token on
   chat requests places them in Copilot's auto billing/rate-limit pool.
2. **`POST /models/session/intent`** — the *intent router*: given the prompt text, it
   classifies the task as `needs_reasoning` or `no_reasoning` and returns a ranked
   list of `candidate_models`. This is the only call that sees the prompt.

The plugin wires these into opencode's hooks:

- **`provider.models`** — opens a session and injects `github-copilot/auto`,
  plus any configured extra autos, each anchored on its own model family from the
  pool (see *Routing*).
- **`chat.message`** — captures the prompt text for the intent router.
- **`chat.params`** — calls the intent router and overrides the outgoing model id.
- **`chat.headers`** — attaches `Copilot-Session-Token` when the selected model is
  in Copilot's auto-session pool.

Backing endpoints are reused exactly as opencode resolves them:

- Claude models → `@ai-sdk/anthropic` + `https://api.githubcopilot.com/v1/messages`
- GPT models → `@ai-sdk/github-copilot` + `https://api.githubcopilot.com/chat/completions`
- Gemini models → in current opencode catalogs these resolve through the same Copilot
  transport as GPT (`@ai-sdk/github-copilot` + `https://api.githubcopilot.com`), so the
  plugin treats them as the GPT endpoint family (some builds may instead expose them via
  `@ai-sdk/google`). Either way, Gemini is not always included in Copilot's auto session
  pool, which is the real limitation (see below), not the SDK.

### Gemini and other non-session models

Gemini support is **limited / buyer beware**.

Copilot may list Gemini models in opencode, but omit them from the `/models/session`
`available_models` pool. When that happens, sending Gemini with the
`Copilot-Session-Token` fails with errors like `Requested model not available for
session`.

To keep `Auto Gemini` usable, the plugin can still call `/models/session/intent` to
classify the prompt as `needs_reasoning` or `no_reasoning`, then map that label onto
your configured Gemini `reasoning` / `noReasoning` lists. The final Gemini request is
sent **without** `Copilot-Session-Token` in that fallback path. That means:

- `Auto Gemini` is best-effort configured routing, not guaranteed real Copilot auto.
- It may not share Copilot auto-session billing, rate-limit, or fallback semantics.
- Claude and GPT/Codex are the safer choices for real Copilot auto-session behavior.

The same warning applies to any other model family that opencode lists but Copilot's
auto session pool does not include.

> **Note on parity:** in shipped VS Code the intent router is gated behind a
> Team-Internal experiment flag (`UseAutoModeRouting`) and only runs in Panel chat,
> so most users' "auto" is just the availability pick from `/models/session`. This
> plugin always calls the router — closer to *internal* VS Code — to get genuine
> per-prompt, reasoning-vs-fast routing.

### Routing flow

1. **Session open** (`provider.models`): `POST /models/session` returns a pool of
   candidate models spanning both Claude (Anthropic) and GPT (OpenAI-compat)
   families, plus a session token. The plugin picks an anchor model and endpoint
   family from the pool for each injected auto.
2. **Turn 0 of a conversation**: `POST /models/session/intent` classifies the prompt.
   The routing label (`needs_reasoning` / `no_reasoning`) is **independent of model
   family** — the router ranks models from all families in one list. The plugin then
   picks the best match **within the anchored family** (see constraint below).
3. **Turns 1+**: the routing decision is cached for the rest of the conversation
   (KV cache stability, same as VS Code). The model does not change mid-conversation.
4. **After compaction** (`session.compacted`): the router is invalidated and
   re-evaluates on the next turn.

### Reasoning effort

When the router flags `needs_reasoning`, the chosen model's effort is raised
(`reasoning_effort: high` for OpenAI/Copilot, extended-thinking budget for Anthropic).
Fast turns are left at the model default (boost-only).

### Within-family constraint

Each injected auto model has **one fixed endpoint** (copied from that auto's
anchor model's `api.npm` + `api.url` at session start). `chat.params` can only
override the model ID sent to that endpoint, not the endpoint itself. This means:

- Routing always stays within the endpoint family (Claude or GPT for true Copilot
  auto-session routing; Gemini is limited as described above).
- A cross-family routing preference — e.g. GPT for fast tasks when the anchor is
  Claude — is **not supported without a proxy**. Cross-family entries in `reasoning`
  / `noReasoning` options are silently skipped.
- The intent router's candidate list does span both families, so a "best possible"
  cross-family choice still requires either separate auto models in the picker
  (one per family) or a request proxy.

### Multiple autos from one plugin entry

Use `autos` to inject additional picker models from the same plugin instance:

```jsonc
{
  "plugin": [
    [
      "opencode-github-copilot-auto-model",
      {
        "autos": [
          {
            "preferredModels": ["claude-sonnet-4.6", "claude-haiku-4.5"]
          },
          {
            "name": "Auto GPT/Codex",
            "preferredModels": ["gpt-5.4", "gpt-5.4-mini"]
          },
          {
            // Limited/best-effort: see "Gemini and other non-session models".
            "name": "Auto Gemini",
            "preferredModels": ["gemini-3.1-pro-preview", "gemini-3.5-flash"]
          }
        ]
      }
    ]
  ]
}
```

Notes:

- The legacy top-level options still define the original `Auto` picker model.
- Each `autos[]` entry gets its own session token cache and sticky router state.
- `id` and `name` are optional. When omitted, the plugin derives them from the
  anchored family where possible, for example `Auto Claude` / `auto-claude`.
- A configured auto is only useful when its preferred models share the same real
  Copilot transport family, meaning the same `api.npm` and `api.url`.
- For full Copilot auto-session behavior, prefer Claude and GPT/Codex autos. Gemini
  autos are limited/best-effort if Gemini is missing from Copilot's session pool.

### Model preference options: when are they useful?

`preferredModels`: nudge which model from the pool is used as the anchor and fallback
default. Useful if you always want a specific model family or tier (e.g. always anchor
on Claude Sonnet rather than whatever Copilot's session picks as default).

`reasoning` / `noReasoning`: override candidate selection within the anchor family
after the routing label is known. Useful for within-family tier control — for example,
if your anchor is Claude, `{ reasoning: ["claude-sonnet-4.6"], noReasoning: ["claude-haiku-4.5"] }`
routes heavy prompts to Sonnet and fast prompts to Haiku. These options have no effect
across families (see the cross-family note above).

## First-party gating

`/models/session/intent` is gated to first-party clients (VS Code) via a
`Copilot-Integration-Id` header. For some accounts the endpoints answer without it.
`copilotHeaders()` keeps that impersonation header (and the `Editor-Version` /
`Editor-Plugin-Version` headers) commented out so you can test the minimal set; the
log shows whether the router answered or returned `404`.

## Logging

The plugin logs to a file to keep the TUI clean:

```bash
tail -f ~/.local/state/opencode-github-copilot-auto-model/plugin.log
```

You'll see the session pool, each router decision (`intent routed -> …`), and the
per-turn model override. Session tokens are never logged.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

## Publishing

Publishing is done locally using npm's browser-based OAuth login (no long-lived
tokens required).

1. Bump the version in `package.json`.
2. Commit and tag:
   ```sh
   git add package.json
   git commit -m "chore: release v0.x.y"
   git tag v0.x.y
   ```
3. Log in to npm (opens a browser tab for one-time OAuth):
   ```sh
   npm login --auth-type=web
   ```
4. Build and publish:
   ```sh
   npm run prepublishOnly   # typecheck + test + build
   npm publish
   ```
5. Push the commit and tag:
   ```sh
   git push origin master --tags
   ```
