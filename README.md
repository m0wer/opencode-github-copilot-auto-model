# opencode-github-copilot-auto-model

Adds a `github-copilot/auto` model to opencode that routes through Claude Sonnet 4.6 (or whichever auto-eligible Copilot model you have available).

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

The model will then appear as **`Auto → Claude Sonnet 4.6`** (or whichever was picked) in the prompt bar.

## Preference order

The plugin selects the first available model from this list:

1. `claude-sonnet-4.6`
2. `gpt-5.3-codex`
3. `claude-haiku-4.5`
4. Any other Copilot model (fallback)

To pin a specific model as the first choice:

```jsonc
{
  "plugin": [
    [
      "github:m0wer/opencode-github-copilot-auto-model",
      { "preferredModel": "gpt-5.3-codex" }
    ]
  ]
}
```

`preferredModel` must match a key from `opencode models` for the `github-copilot` provider (e.g. `gpt-5.3-codex`, `claude-sonnet-4.6`, `claude-haiku-4.5`).

## How it works

The plugin hooks into opencode's provider model discovery for `github-copilot`. It copies the chosen template model's full API config (`npm`, `url`, `api.id`) so routing is identical to using that model directly:

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
