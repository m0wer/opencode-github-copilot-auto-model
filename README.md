# opencode-github-copilot-auto-model

Adds a `github-copilot/auto` model to opencode using GitHub Copilot's own auto-session routing.

GitHub Copilot's `auto` model ID is not accepted by the API directly — it only works as a client-side selection concept. This plugin picks the best available model from Copilot's actual "auto" pool and exposes it as `github-copilot/auto` in the model picker.

## Install

Add to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "github:m0wer/opencode-github-copilot-auto-model"
  ]
}
```

The model will then appear as **`Auto → <selected model>`** in the prompt bar.

## How it works

The plugin hooks into opencode's provider model discovery for `github-copilot`. It first calls Copilot's `/models/session` endpoint to get the current auto session token and selected model, then aliases `github-copilot/auto` to that backing model while keeping the `Auto → ...` display label. For runtime requests it forwards `Copilot-Session-Token` and overrides the outgoing chat body model so routing follows Copilot's auto session decisions.

- Claude models → `@ai-sdk/anthropic` + `https://api.githubcopilot.com/v1/messages`
- GPT models → `@ai-sdk/github-copilot` + `https://api.githubcopilot.com/chat/completions`

## Logging

The plugin logs which model was selected to a file, keeping the TUI clean:

```
~/.local/state/opencode-github-copilot-auto-model/plugin.log
```

```bash
tail -f ~/.local/state/opencode-github-copilot-auto-model/plugin.log
```

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
