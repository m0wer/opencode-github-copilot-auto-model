# opencode-github-copilot-auto-model

Adds a `github-copilot/auto` model to opencode that follows GitHub Copilot's own
auto model selection — including the per-turn **intent router** that VS Code uses.

GitHub Copilot's `auto` ID isn't accepted by the chat API directly; "auto" is a
client-side concept backed by two server endpoints. This plugin drives them from
opencode and adds the model to the picker as **`Auto`**.

> **What the UI shows:** the picker and status bar always read **`Auto`**. When the
> router (re)picks a model you get a toast — e.g. `Auto → gpt-5.4 · needs_reasoning`
> (it stays silent if the pick is unchanged). The log has the full detail
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

## How it works

Copilot "auto" is two server calls on `https://api.githubcopilot.com`:

1. **`POST /models/session`** — opens an auto session: returns the candidate model
   pool and a `Copilot-Session-Token`. Forwarding that token on chat requests is
   what places them in Copilot's auto billing/rate-limit pool.
2. **`POST /models/session/intent`** — the *router*: given the prompt, it returns a
   ranked candidate list (reasoning vs. not). This is the only call that sees the
   prompt.

> **Note on parity:** in shipped VS Code the intent router is gated behind a
> Team-Internal experiment flag (`UseAutoModeRouting`) and only runs in Panel chat,
> so most users' "auto" is just the availability pick from `/models/session`. This
> plugin always calls the router — closer to *internal* VS Code than the default
> build — to get genuine per-prompt, reasoning-vs-fast routing.

The plugin wires these into opencode's hooks:

- **`provider.models`** — opens a session and injects `github-copilot/auto`,
  anchored on a model family from the pool (see *Routing*).
- **`chat.message`** — captures the prompt text for the router.
- **`chat.params`** — calls the intent router and overrides the outgoing model id.
- **`chat.headers`** — attaches `Copilot-Session-Token` to each request.

Backing endpoints are reused exactly as opencode resolves them:

- Claude models → `@ai-sdk/anthropic` + `https://api.githubcopilot.com/v1/messages`
- GPT models → `@ai-sdk/github-copilot` + `https://api.githubcopilot.com/chat/completions`

## Routing

- **Family by availability, tier by task.** Copilot's session picks the model
  *family* (Claude or GPT) based on availability; the intent router then picks the
  *tier* within that family — a reasoning model vs. a fast one — from your prompt.
  The injected `auto` model has a single endpoint, so routing stays within the
  family; a different-family candidate is skipped (mirrors VS Code's provider
  stickiness, which also preserves prompt caching). The anchor family is guaranteed
  to have at least two tiers, so the router always has something to choose between.
- **Per conversation.** Each opencode session gets its own auto session (token +
  pool), refreshed every turn so tokens never go stale mid-conversation.
- **Cache-stable cadence.** The router runs once on the first turn, then the chosen
  model sticks for the rest of the conversation (keeping the prompt KV cache warm),
  re-evaluating only after compaction (`session.compacted`). This matches VS Code's
  automode router.
- **Reasoning effort.** When the router flags a turn `needs_reasoning`, the routed
  model's effort is raised (`reasoning_effort: high` for OpenAI/Copilot, an
  extended-thinking budget for Anthropic) — applied every turn so it stays consistent.
  Fast turns are left at the model default (boost-only).

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
