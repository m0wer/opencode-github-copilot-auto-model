import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"

const MODEL_ID = "auto"
const PROVIDER_ID = "github-copilot"

// Preference order matches the models GitHub Copilot's own "auto" feature picks from.
// Model keys as they appear in opencode's model picker (github-copilot/<key>).
const AUTO_ELIGIBLE = ["claude-sonnet-4.6", "gpt-5.3-codex", "claude-haiku-4.5"]

type Options = {
  // Override the first-choice model key (e.g. "gpt-5.3-codex").
  // Must be a model key from `opencode models` for github-copilot.
  preferredModel?: string
}

function pickTemplate(models: Record<string, Model>, preferred?: string) {
  if (preferred && models[preferred]) return models[preferred]
  for (const id of AUTO_ELIGIBLE) {
    if (models[id]) return models[id]
  }
  // Broader fallback: any Copilot model
  return Object.values(models).find((m) => m.providerID === PROVIDER_ID)
}

// File logger — avoids polluting the TUI.
// Tail ~/.local/state/opencode-github-copilot-auto-model/plugin.log to observe.
function logFile() {
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "opencode-github-copilot-auto-model",
      "plugin.log",
    )
  const xdg = process.env.XDG_STATE_HOME
  return path.join(xdg ?? path.join(homedir(), ".local", "state"), "opencode-github-copilot-auto-model", "plugin.log")
}

let logReady: Promise<void> | undefined
function log(msg: string) {
  const file = logFile()
  if (!logReady) logReady = mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
  void logReady.then(() => appendFile(file, `${new Date().toISOString()} info ${msg}\n`).catch(() => undefined))
}

function withAutoModel(models: Record<string, Model>, preferred?: string) {
  if (models[MODEL_ID]) return models
  const template = pickTemplate(models, preferred)
  if (!template) return models
  // Copy the template's api (id, npm, url) exactly — they already point to the right endpoint.
  // Claude models: url="…/v1" + npm="@ai-sdk/anthropic" → appends /messages → correct.
  // GPT models:   url="…"    + npm="@ai-sdk/github-copilot" → appends /chat/completions → correct.
  // Do NOT strip /v1 from the url; the Anthropic SDK appends /messages (not /v1/messages).
  log(`injected auto → ${template.id} (api.id=${template.api.id}, npm=${template.api.npm}, url=${template.api.url})`)
  return {
    ...models,
    [MODEL_ID]: {
      ...template,
      id: MODEL_ID,
      name: `Auto → ${template.name}`,
      family: "github-copilot-auto",
      variants: undefined,
    },
  }
}

const CopilotAutoModelPlugin: Plugin = async (_input, options) => {
  const preferred = ((options ?? {}) as Options).preferredModel
  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return withAutoModel(provider.models, preferred)
      },
    },
  }
}

export default { server: CopilotAutoModelPlugin, id: "opencode-github-copilot-auto-model" }
