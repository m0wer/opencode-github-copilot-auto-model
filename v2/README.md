# OpenCode V2 port

This directory is a straight port of the V1 plugin in `src/` to the
OpenCode V2 plugin API (`export default { id, setup(ctx) }`). V1 plugins
don't load on V2 at all, so this exists for anyone running current
OpenCode who still wants the auto models.

## Install

Copy this folder somewhere stable, e.g. `~/.config/opencode/plugins/copilot-auto`,
then reference it from `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.config/opencode/plugins/copilot-auto",
      "options": {
        "autos": [
          {
            "id": "auto-gpt-5.6-luna",
            "name": "Auto GPT-5.6-Luna",
            "preferredModels": ["gpt-5.6-luna", "gpt-6-luna"]
          },
          {
            "id": "auto-gpt-5.3-codex",
            "name": "Auto GPT-5.3-Codex",
            "preferredModels": ["gpt-5.3-codex"]
          }
        ]
      }
    }
  ]
}
```

Omit `autos` and you get the defaults: `auto`, one per supported family,
with Auto GPT anchored on GPT-5.6 Luna when it's in the catalog.

## How routing works here

Same idea as the V1 plugin, adapted to what V2 allows:

- Models are injected through `ctx.provider.transform`, one auto per
  family (or per your `autos` list).
- The prompt is captured with the `prompt` session hook, routing happens
  in the `context` hook by rewriting the model reference, and the
  `Copilot-Session-Token` goes out through the `model.request` hook.
- Luna-anchored autos use Copilot's single-call `POST /auto` router
  (the same endpoint current VS Code uses), since Luna never appears in
  the legacy `POST /models/session` pool. Verified live: code prompts
  route to `gpt-5.6-luna` across tiers. Everything else keeps the
  legacy session + intent flow.
- First-party chat headers (`Copilot-Integration-Id: vscode-chat` and
  the VS Code version stamps) are set on Copilot requests, and
  `temperature` is stripped for Luna, which rejects it.

Watch it work with:

```
tail -f ~/.local/state/opencode-github-copilot-auto-model/plugin.log
```
