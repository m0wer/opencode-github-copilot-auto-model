# opencode-github-copilot-auto-model

Adds `github-copilot/auto` to opencode, plus per-family autos: by default the
plugin also injects **`Auto Claude`** and **`Auto GPT`** when those families are
available in your Copilot catalog.

GitHub Copilot's `auto` ID isn't accepted by the chat API directly; "auto" is a
client-side concept backed by a server routing call (`POST /auto`, the same one
VS Code uses). This plugin drives it from opencode and adds the models to the
picker as **`Auto`** plus the default per-family autos (or any configured autos,
which replace the defaults).

> **What the UI shows:** the picker and status bar read **`Auto`** (static label;
> the routing decision is surfaced as a transient toast — e.g. `Auto → gpt-5.4`,
> or `Auto Claude → claude-sonnet-4.6 · no Auto session` when the server's pick
> could not be used). The log has full detail (`chat.params override auto -> …`).

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


Optional configuration (all settings are optional; Copilot routing always runs):

```jsonc
{
  "plugin": [
    [
      "opencode-github-copilot-auto-model",
      {
        // Routing profile sent to POST /auto:
        // "efficiency" | "balance" (default) | "intelligence" | "fast".
        "tier": "balance",

        // Ordered list of preferred models. The first one anchors the endpoint
        // of the `Auto` model and is the fallback when the server's pick cannot
        // be served by that endpoint. Accepts model keys or API ids.
        "preferredModels": ["gpt-5.4"],

        // Additional picker autos, all from this one plugin instance.
        // When omitted, the plugin injects one default auto per supported family
        // (Auto Claude, Auto GPT) that has at least two catalog models.
        // Set [] to disable the defaults; an explicit list replaces them.
        // `name` and `id` are optional; the plugin derives them when omitted.
        "autos": [
          { "preferredModels": ["claude-sonnet-4.6"] },
          { "name": "Auto Max", "preferredModels": ["gpt-5.4"], "tier": "intelligence" }
        ]
      }
    ]
  ]
}
```

Options summary:

| Option | Type | Description |
|--------|------|-------------|
| `tier` | string | Routing profile for `Auto`: `efficiency`, `balance` (default), `intelligence` or `fast`. Retired names `eco`, `balanced`, `max` are mapped forward. |
| `preferredModels` | string[] | Endpoint anchor and fallback model for `Auto`; also wins when the legacy pool offers several models. |
| `autos` | object[] | Additional injected autos. Each entry can set `id`, `name`, `preferredModels` and `tier`. Defaults to one auto per supported family (Claude, GPT) with at least two catalog models; `[]` disables the defaults. |
| `reasoning` / `noReasoning` | string[] | **Deprecated, ignored.** `POST /auto` returns no reasoning verdict; use `tier` instead. |

## How it works

### Copilot auto: `POST /auto`

VS Code's Auto (`extensions/copilot/src/platform/endpoint/node/autoV2Fetcher.ts`
in `microsoft/vscode`) makes a single call on `https://api.githubcopilot.com`:

```
POST /auto
{ "prompt": "<user prompt>", "tier": "balance", "has_image": true? }
→ { "session_token", "expires_at", "selected_model": { "id", ... }, "discounted_costs"?, "hydra_scores"? }
```

The server routes the prompt, picks **one** model and mints a session token
(valid 24h, no refresh). Chat requests for that model carry the token in
`Copilot-Session-Token`, which places them in Copilot's Auto pool and discount.

The plugin wires this into opencode's hooks:

- **`provider.models`** — injects `github-copilot/auto` and the extra autos, each
  cloned from an anchor model (no network call: routing needs a prompt).
- **`chat.message`** — captures the prompt text (and whether an image is attached).
- **`chat.params`** — on the first turn of a conversation calls `POST /auto` and
  pins the conversation to the selected model.
- **`chat.headers`** — attaches `Copilot-Session-Token` when the server's pick is
  the model being sent, plus a private `x-copilot-auto-route` header.
- **fetch wrapper** — opencode builds the auto's language model from the anchor's
  `api.id`, and its Copilot/Anthropic SDKs ignore a `model` passed via
  `chat.params` options. So the plugin wraps the global `fetch` once: requests
  carrying `x-copilot-auto-route` get that header stripped and the JSON body's
  `model` replaced. All other requests pass through untouched.

> **Auto V1 is gone.** Until v0.2 this plugin used VS Code's old two-call flow
> (`POST /models/session` for a candidate pool + `POST /models/session/intent`
> for a reasoning verdict). VS Code removed that flow in August 2026, and the
> legacy pool stopped receiving new models and shrank over time (Sonnet, Codex
> and Haiku dropped out). `/models/session` is now only used as a fallback when
> `/auto` fails.

### Routing flow

1. **Turn 0 of a conversation**: `POST /auto` with the prompt and the auto's tier.
2. If the selected model can be sent through this auto's endpoint (see below),
   the conversation is pinned to it, with the session token.
3. Otherwise the auto falls back to its anchor model **without** the token (full
   price, outside the Auto pool) for the rest of that session. The toast and log
   say so.
4. **Turns 1+** reuse the pinned model (KV cache stability, same as VS Code).
5. **Re-routing** happens after compaction (`session.compacted`), when the token is
   within five minutes of expiry, or on the next turn after a failed routing call.
6. If `/auto` fails, the legacy `/models/session` pool is tried; if that fails too,
   the anchor is used without a token and routing is retried on the next turn.

### Reasoning effort

On the `intelligence` tier the routed model's effort is raised
(`reasoning_effort: high` for OpenAI/Copilot, extended-thinking budget for
Anthropic). Other tiers keep the model default.

### Within-family constraint

Each injected auto model has **one fixed endpoint** (copied from its anchor
model's `api.npm` + `api.url`). `chat.params` can only override the model id sent
to that endpoint, not the endpoint itself:

- `Auto` (no preferences) anchors on the shared Copilot transport
  (`@ai-sdk/github-copilot`), which serves GPT, MAI and Gemini picks. A Claude
  pick goes through `@ai-sdk/anthropic` and cannot be sent by it.
- `Auto Claude` / `Auto GPT` are additionally clamped to their family label, so
  `Auto GPT` will not send a Gemini pick even though they share a transport.
- The routed model must also use the anchor's wire API: opencode sends GPT-5+
  (except `gpt-5-mini`) over the Responses API and other Copilot models (MAI,
  Gemini, older GPT) over Chat Completions, and the bodies differ. With a
  `gpt-5.4` anchor, a `mai-code-1.1-flash` pick therefore falls back.
- `POST /auto` picks a single model across all families, so a family auto only
  gets the Auto session (and discount) when the server picks its family.
- A model the server picks that is missing from opencode's catalog cannot be
  sent either (the endpoint is unknown); the anchor is used instead.

### Multiple autos from one plugin entry

By default (no `autos` key), the plugin injects one auto per supported family in
addition to the legacy `Auto`:

- `Auto Claude` (`auto-claude`) when at least two Claude models are in the catalog.
- `Auto GPT` (`auto-gpt`) when at least two GPT/Codex models are in the catalog.

To disable the defaults, set `"autos": []`. An explicit `autos` list replaces them.

Notes:

- The top-level options define the original `Auto` picker model.
- Each auto (default or configured) keeps its own routing state per conversation.
- `id` and `name` are optional. When omitted, the plugin derives them from the
  anchored family where possible, for example `Auto Claude` / `auto-claude`.
- Use `tier` per auto to expose several routing profiles side by side, e.g. an
  `Auto Max` on `intelligence` next to the default `balance` one.

## First-party gating

VS Code sends `Copilot-Integration-Id` (and `Editor-Version` /
`Editor-Plugin-Version`) on `POST /auto`. `copilotHeaders()` keeps those
commented out so the minimal set is tried first; the log shows whether `/auto`
answered (`auto decision: …`) or returned an error (`auto fetch non-ok: …`), in
which case the legacy pool is used.

## Logging

The plugin logs to a file to keep the TUI clean:

```bash
tail -f ~/.local/state/opencode-github-copilot-auto-model/plugin.log
```

You'll see each routing decision (`auto decision: selected_model=…`), fallbacks,
and the per-turn model override. Prompts and session tokens are never logged (only
the prompt length).

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
