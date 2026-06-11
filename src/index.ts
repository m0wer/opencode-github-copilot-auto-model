import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"

const MODEL_ID = "auto"
const PROVIDER_ID = "github-copilot"
const COPILOT_API_VERSION = "2026-01-09"

// Preference order matches the models GitHub Copilot's own "auto" feature picks from.
// Model keys as they appear in opencode's model picker (github-copilot/<key>).
const AUTO_ELIGIBLE = ["claude-sonnet-4.6", "gpt-5.3-codex", "claude-haiku-4.5"]

type Options = {
  // Override the first-choice model key (e.g. "gpt-5.3-codex").
  // Must be a model key from `opencode models` for github-copilot.
  preferredModel?: string
}

type AutoSessionState = {
  selectedModelID: string
  sessionToken: string
  expiresAtMs: number
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

let selectedAutoApiModelID: string | undefined
let selectedAutoSessionToken: string | undefined
let autoSession: AutoSessionState | undefined

function capiBase(url: string) {
  const clean = url.replace(/\/+$/, "")
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean
}

async function getAutoSession(baseURL: string, bearer: string) {
  const now = Date.now()
  if (autoSession && now < autoSession.expiresAtMs - 60_000) return autoSession

  const response = await fetch(`${baseURL}/models/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": COPILOT_API_VERSION,
    },
    body: JSON.stringify({ auto_mode: { model_hints: [MODEL_ID] } }),
  }).catch((error) => {
    log(`auto session fetch failed: ${String(error)}`)
    return undefined
  })

  if (!response) return autoSession
  if (!response.ok) {
    log(`auto session fetch non-ok: ${response.status}`)
    return autoSession
  }

  const data = (await response.json().catch(() => undefined)) as
    | {
        selected_model?: unknown
        session_token?: unknown
        expires_at?: unknown
      }
    | undefined

  if (!data || typeof data.selected_model !== "string" || typeof data.session_token !== "string") {
    log("auto session fetch invalid payload")
    return autoSession
  }

  const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : now + 30 * 60_000
  autoSession = {
    selectedModelID: data.selected_model,
    sessionToken: data.session_token,
    expiresAtMs,
  }
  log(`auto session selected_model=${autoSession.selectedModelID}`)
  return autoSession
}

function withAutoModel(models: Record<string, Model>, preferred?: string, selected?: Model) {
  if (models[MODEL_ID]) return models
  const template = selected ?? pickTemplate(models, preferred)
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
      id: template.id,
      name: `Auto → ${template.name}`,
      family: "github-copilot-auto",
      variants: undefined,
    },
  }
}

const CopilotAutoModelPlugin: Plugin = async (_input, options) => {
  const preferred = ((options ?? {}) as Options).preferredModel

  return {
    "chat.params": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      if (incoming.model.id !== MODEL_ID) return
      if (!selectedAutoApiModelID || selectedAutoApiModelID === MODEL_ID) return
      output.options.model = selectedAutoApiModelID
      log(`chat.params override auto -> ${selectedAutoApiModelID}`)
    },
    "chat.headers": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      if (incoming.model.id !== MODEL_ID) return
      if (!selectedAutoSessionToken) return
      output.headers["Copilot-Session-Token"] = selectedAutoSessionToken
      log("chat.headers added Copilot-Session-Token for auto")
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        let template = pickTemplate(provider.models, preferred)
        selectedAutoSessionToken = undefined

        if (template && ctx.auth?.type === "oauth") {
          const session = await getAutoSession(capiBase(template.api.url), ctx.auth.refresh)
          if (session) {
            selectedAutoApiModelID = session.selectedModelID
            selectedAutoSessionToken = session.sessionToken
            template =
              Object.values(provider.models).find(
                (model) => model.providerID === PROVIDER_ID && model.api.id === session.selectedModelID,
              ) ?? template
          }
        }

        if (template) selectedAutoApiModelID = template.api.id
        return withAutoModel(provider.models, preferred, template)
      },
    },
  }
}

export default { server: CopilotAutoModelPlugin, id: "opencode-github-copilot-auto-model" }
