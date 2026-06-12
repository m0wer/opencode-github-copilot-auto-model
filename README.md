# opencode-github-copilot-auto-model

Adds a `github-copilot/auto` model to opencode that follows GitHub Copilot's own
auto model selection — including the per-turn **intent router** that VS Code uses.

GitHub Copilot's `auto` ID isn't accepted by the chat API directly; "auto" is a
client-side concept backed by two server endpoints. This plugin drives them from
opencode and adds the model to the picker as **`Auto`**.

> **What the UI shows:** the picker and status bar read **`Auto`** (static label;
> the per-turn routing decision is surfaced as a transient toast — e.g.
> `Auto → gpt-5.4 · needs_reasoning`). The log has full detail
> (`chat.params override auto -> …`).

## Install

Add to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "github:m0wer/opencode-github-copilot-auto-model"
  ]
}
```

Optional configuration (all settings are optional; Copilot session + intent routing
always runs regardless):

```jsonc
{
  "plugin": [
    [
      "github:m0wer/opencode-github-copilot-auto-model",
      {
        // General preference: which model to prefer when present in the session pool.
        // Accepts a model key (e.g. "claude-sonnet-4.6") or API id; ordered fallback list.
        "preferredModel": "claude-sonnet-4.6",
        "preferredModels": ["claude-sonnet-4.6", "claude-haiku-4.5"],

        // Per-label preferences: steer candidate selection per routing verdict.
        // Only models in the same endpoint family as the anchor are considered
        // (see "Within-family constraint" below).
        "reasoning": "claude-sonnet-4.6",
        "noReasoning": ["claude-haiku-4.5", "claude-sonnet-4.6"]
      }
    ]
  ]
}
```

Options summary:

| Option | Type | Description |
|--------|------|-------------|
| `preferredModel` | string | Model key or API id to prefer in the session pool. |
| `preferredModels` | string[] | Ordered fallback list; first pool match wins. |
| `reasoning` | string \| string[] | Preferred model(s) when the intent router returns `needs_reasoning`. |
| `noReasoning` | string \| string[] | Preferred model(s) when the intent router returns `no_reasoning`. |

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
  anchored on a model family from the pool (see *Routing*).
- **`chat.message`** — captures the prompt text for the intent router.
- **`chat.params`** — calls the intent router and overrides the outgoing model id.
- **`chat.headers`** — attaches `Copilot-Session-Token` to each request.

Backing endpoints are reused exactly as opencode resolves them:

- Claude models → `@ai-sdk/anthropic` + `https://api.githubcopilot.com/v1/messages`
- GPT models → `@ai-sdk/github-copilot` + `https://api.githubcopilot.com/chat/completions`

> **Note on parity:** in shipped VS Code the intent router is gated behind a
> Team-Internal experiment flag (`UseAutoModeRouting`) and only runs in Panel chat,
> so most users' "auto" is just the availability pick from `/models/session`. This
> plugin always calls the router — closer to *internal* VS Code — to get genuine
> per-prompt, reasoning-vs-fast routing.

### Routing flow

1. **Session open** (`provider.models`): `POST /models/session` returns a pool of
   candidate models spanning both Claude (Anthropic) and GPT (OpenAI-compat) families,
   plus a session token. The plugin picks an anchor model and endpoint family from the pool.
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

The injected `auto` model has **one fixed endpoint** (copied from the anchor model's
`api.npm` + `api.url` at session start). `chat.params` can only override the model ID
sent to that endpoint, not the endpoint itself. This means:

- Routing always stays within the endpoint family (Claude or GPT, not both).
- A cross-family routing preference — e.g. GPT for fast tasks when the anchor is
  Claude — is **not supported without a proxy**. Cross-family entries in `reasoning`
  / `noReasoning` options are silently skipped.
- The intent router's candidate list does span both families, so a "best possible"
  cross-family choice would require either two separate auto models in the picker
  (one per family) or a request proxy.

### Model preference options: when are they useful?

`preferredModel` / `preferredModels`: nudge which model from the pool is used as the
anchor and fallback default. Useful if you always want a specific model family or tier
(e.g. always prefer Sonnet over Codex as the anchor).

`reasoning` / `noReasoning`: override candidate selection within the anchor family
after the routing label is known. Useful for within-family tier control — for example,
if your anchor is Claude, `{ reasoning: "claude-sonnet-4.6", noReasoning: "claude-haiku-4.5" }`
routes heavy prompts to Sonnet and fast prompts to Haiku. This has no effect across
families.

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
