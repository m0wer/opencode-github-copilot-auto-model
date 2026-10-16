# opencode-github-copilot-auto-model

Adds `github-copilot/auto` to opencode, plus per-family autos: by default the
plugin also injects **`Auto Claude`** and **`Auto GPT`** when those families are
available in your Copilot catalog.

GitHub Copilot's `auto` ID isn't accepted by the chat API directly; "auto" is a
client-side concept backed by a server routing call (`POST /auto`, the same one
VS Code uses). This plugin drives it from opencode and adds the models to the
picker as **`Auto`** plus the default per-family autos (or any configured autos,
which replace the defaults).

> **What the UI shows:** the picker reads **`Auto`** with the anchor model's
> metadata; the model each conversation is actually routed to is in the log
> (`auto → gpt-6-luna for ses_…`, `request model gpt-5.4 -> gpt-6-luna`).

## Install

This is the **2.x** line, for **opencode 2** (the `plugins` config key and the
`Plugin.define({ id, setup })` plugin API). For opencode 1 use the **1.x** line
(branch `1.x`).

| opencode | plugin version |
|----------|----------------|
| 1.x (≥ 1.18.29) | `opencode-github-copilot-auto-model@^1` |
| 2.x | `opencode-github-copilot-auto-model@^2` |

Add the package to `~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "plugins": [
    "opencode-github-copilot-auto-model@^2"
  ]
}
```

opencode installs it from npm on first run. Sign in to GitHub Copilot in
opencode as usual; the plugin uses that connection.

Optional configuration (all settings are optional; Copilot routing always runs):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-github-copilot-auto-model@^2",
      "options": {
        // Routing profile sent to POST /auto:
        // "efficiency" | "balance" (default) | "intelligence" | "fast".
        "tier": "balance",

        // Ordered list of preferred models. The first one anchors the endpoint
        // of the `Auto` model and is the fallback when the server's pick cannot
        // be served by that endpoint. Accepts model keys or API ids.
        "preferredModels": ["gpt-6-luna"],

        // Additional picker autos, all from this one plugin instance.
        // When omitted, the plugin injects one default auto per supported family
        // (Auto Claude, Auto GPT) that has at least two catalog models.
        // Set [] to disable the defaults; an explicit list replaces them.
        // `name` and `id` are optional; the plugin derives them when omitted.
        "autos": [
          { "preferredModels": ["claude-sonnet-5.5"] },
          { "name": "Auto Max", "preferredModels": ["gpt-6.1-sol"], "tier": "intelligence" }
        ]
      }
    }
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

The plugin wires this into opencode 2's plugin API:

- **`ctx.model.transform`** — injects `github-copilot/auto` and the extra autos,
  each cloned from an anchor model in the live Copilot catalog (same SDK,
  endpoint and `modelID`). No network call: routing needs a prompt.
- **`session.hook("prompt")`** — captures the user's prompt (and whether an
  image is attached).
- **`session.hook("model.request")`** — on the first request of a conversation
  calls `POST /auto` with the Copilot connection's token, pins the conversation
  to the selected model and adds `Copilot-Session-Token`.
- **`session.hook("http.request")`** — opencode built the request for the
  anchor's `modelID`; the plugin swaps the routed model into the JSON body.
- **`session.hook("context")`** — raises reasoning effort on the `intelligence`
  tier.
- **`session.hook("compaction")`** — re-routes on the next agent turn.

> **Auto V1 is gone.** Until v0.2 this plugin used VS Code's old two-call flow
> (`POST /models/session` for a candidate pool + `POST /models/session/intent`
> for a reasoning verdict). VS Code removed that flow in August 2026, and the
> legacy pool stopped receiving new models and shrank over time. `/models/session`
> is now only used as a fallback when `/auto` fails.

### Routing flow

1. **First request of a conversation**: `POST /auto` with the prompt and the
   auto's tier.
2. If the selected model can be sent through this auto's endpoint (see below),
   the conversation is pinned to it, with the session token.
3. Otherwise the auto falls back to its anchor model **without** the token (full
   price, outside the Auto pool) for the rest of that session. The log says so.
4. **Later requests** (tool steps, follow-up turns) reuse the pinned model (KV
   cache stability, same as VS Code).
5. **Re-routing** happens on the next agent turn after compaction, when the token
   is within five minutes of expiry, or after a failed routing call.
6. If `/auto` fails, the legacy `/models/session` pool is tried; if that fails too,
   the anchor is used without a token and routing is retried on the next request.

### Reasoning effort

On the `intelligence` tier the routed model's effort is raised
(`reasoningEffort: high` on the Responses/Chat API, an extended-thinking budget
on Anthropic Messages), unless a model variant is selected. Other tiers keep the
model default.

### Within-family constraint

Each injected auto model has **one fixed endpoint** (cloned from its anchor).
The plugin can only change the model id in the request body, not the endpoint or
the body shape:

- A routed model must share the anchor's SDK and base URL (Claude rides
  Anthropic Messages on `/v1`; GPT, MAI and Gemini ride the Copilot SDK) **and**
  its wire API (`settings.endpoint` from the live catalog: `responses`, `chat` or
  `messages`).
- `Auto` (no preferences) anchors on a GPT model served over Responses, which is
  what `POST /auto` picks most; MAI Code also qualifies, Gemini (Chat) and Claude
  (Messages) do not.
- `Auto Claude` / `Auto GPT` are additionally clamped to their family label, so
  `Auto GPT` will not send a MAI pick even though they share an endpoint.
- `POST /auto` picks a single model across all families, so a family auto only
  gets the Auto session (and discount) when the server picks its family.
- A model the server picks that is missing from opencode's catalog cannot be
  sent either; the anchor is used instead.

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

VS Code also sends `Copilot-Integration-Id`, `Editor-Version` and
`Editor-Plugin-Version` on `POST /auto`. The plugin does not, to avoid
impersonating VS Code; `/auto` answers without them. The log shows whether
`/auto` answered (`auto decision: …`) or returned an error (`auto fetch non-ok:
…`), in which case the legacy pool is used.

## Logging

The plugin logs to a file to keep the TUI clean:

```bash
tail -f ~/.local/state/opencode-github-copilot-auto-model/plugin.log
```

You'll see each routing decision (`auto decision: selected_model=…`), fallbacks,
and the per-request model swap. Prompts and session tokens are never logged (only
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

Two release lines share the package name: **2.x** (opencode 2) is published from
`master` under npm's default `latest` tag; **1.x** (opencode 1) is maintained on
the `1.x` branch and published with `npm publish --tag v1`, so a 1.x patch never
becomes `latest`.

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
