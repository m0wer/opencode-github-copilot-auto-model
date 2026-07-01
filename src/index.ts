import { randomUUID } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"

const MODEL_ID = "auto"
const PROVIDER_ID = "github-copilot"

// VS Code's copilot-api uses "2026-06-01". The previously-working value here was
// "2026-01-09" — flip back if the session/intent calls start 4xx'ing.
const COPILOT_API_VERSION = "2026-06-01"

// VS Code (`@vscode/copilot-api` _mixinHeaders) ALWAYS stamps these on the gated
// /models/session and /models/session/intent requests — they are never omitted.
// Values are plausible stand-ins generated once per process.
// Editor-Version / Editor-Plugin-Version are currently NOT sent (testing whether the
// CAPI auto endpoints need them). Uncomment these + the header lines to restore the
// real VS Code baseline.
// const EDITOR_VERSION = "vscode/1.99.0"
// const EDITOR_PLUGIN_VERSION = "copilot-chat/0.40.0"
const VSCODE_SESSION_ID = `${randomUUID()}${Date.now()}`
const VSCODE_MACHINE_ID = randomUUID().replace(/-/g, "")
const VSCODE_DEVICE_ID = randomUUID()

// The router endpoint aborts at 1s in VS Code; mirror that so a slow/blocked
// intent call never stalls a turn.
const INTENT_TIMEOUT_MS = 1000

// Refresh a session token this long before its server expiry.
const SESSION_REFRESH_SKEW_MS = 60_000

// Parsed POST /models/session response — one per conversation, like VS Code's token bank.
type AutoSession = {
  selectedModelID: string
  sessionToken: string
  availableModels: string[]
  discountedCosts: Record<string, number>
  expiresAtMs: number
}

// Everything we track per opencode conversation: its auto session (token + pool)
// plus routing memory (turn count, last decision, context signals).
type ConvState = {
  session?: AutoSession
  sessionInflight?: Promise<AutoSession | undefined>
  lastPrompt?: string
  referenceCount?: number
  routedModelID?: string
  routedLabel?: "needs_reasoning" | "no_reasoning"
  needsReEval?: boolean
  omitSessionToken?: boolean
  previousModel?: string
  turn: number
}

// Shape of POST /models/session/intent (router) response. See routerDecisionFetcher.ts.
type RouterDecision = {
  predicted_label?: "needs_reasoning" | "no_reasoning"
  confidence?: number
  candidate_models?: string[]
  scores?: { needs_reasoning: number; no_reasoning: number }
  sticky_override?: boolean
}

type AutoConfig = {
  id?: string
  name?: string
  preferredModels?: string[]
  reasoning?: string[]
  noReasoning?: string[]
}

type Options = {
  // Ordered list of preferred model keys or API ids to use as the session anchor
  // and routing fallback, regardless of routing label.
  preferredModels?: string[]
  // Per-label preference lists: steer candidate selection per routing verdict.
  // Only within-family candidates are valid (the auto model has a single endpoint).
  // Cross-family entries are silently skipped.
  reasoning?: string[]
  noReasoning?: string[]
  // Additional injected autos. Each one anchors independently based on its own
  // preferred model list and keeps its own routing/session cache.
  autos?: AutoConfig[]
}

type AutoDraft = {
  requestedID?: string
  requestedName?: string
  preferredModels: string[]
  reasoning: string[]
  noReasoning: string[]
  legacy: boolean
  index: number
}

type TemplateAPI = {
  id: string
  npm: string
  url: string
}

type InjectedAuto = {
  id: string
  name: string
  preferredModels: string[]
  reasoning: string[]
  noReasoning: string[]
  preferredApiIDs: string[]
  reasoningApiIDs: string[]
  noReasoningApiIDs: string[]
  template?: Model
  templateApi?: TemplateAPI
  catalogDefaultModelID?: string
}

function pickTemplate(models: Record<string, Model>) {
  return Object.values(models).find((m) => m.providerID === PROVIDER_ID)
}

function templateAPI(model: Model): TemplateAPI {
  return { id: model.api.id, npm: model.api.npm, url: model.api.url }
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values?.length) return []
  const deduped: string[] = []
  for (const v of values) {
    const s = v.trim()
    if (s && !deduped.includes(s)) deduped.push(s)
  }
  return deduped
}

function resolvePreferredApiIDs(models: Record<string, Model>, preferred: string[]): string[] {
  const resolved: string[] = []
  const entries = Object.values(models).filter((model) => model.providerID === PROVIDER_ID)
  for (const token of preferred) {
    const byKey = models[token]
    if (byKey?.providerID === PROVIDER_ID) {
      if (!resolved.includes(byKey.api.id)) resolved.push(byKey.api.id)
      continue
    }
    const byApiId = entries.find((model) => model.api.id === token)
    if (byApiId && !resolved.includes(byApiId.api.id)) resolved.push(byApiId.api.id)
  }
  return resolved
}

function autoDrafts(options: Options): AutoDraft[] {
  const drafts: AutoDraft[] = [
    {
      requestedID: MODEL_ID,
      requestedName: "Auto",
      preferredModels: normalizeList(options.preferredModels),
      reasoning: normalizeList(options.reasoning),
      noReasoning: normalizeList(options.noReasoning),
      legacy: true,
      index: 0,
    },
  ]
  for (const [index, auto] of (options.autos ?? []).entries()) {
    drafts.push({
      requestedID: auto.id?.trim() || undefined,
      requestedName: auto.name?.trim() || undefined,
      preferredModels: normalizeList(auto.preferredModels),
      reasoning: normalizeList(auto.reasoning),
      noReasoning: normalizeList(auto.noReasoning),
      legacy: false,
      index: index + 1,
    })
  }
  return drafts
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function uniqueValue(base: string, used: Set<string>, suffix = "-"): string {
  let value = base || "auto"
  let counter = 2
  while (used.has(value)) {
    value = `${base}${suffix}${counter}`
    counter += 1
  }
  used.add(value)
  return value
}

function familyLabel(model?: Model): string | undefined {
  if (!model) return undefined
  const fingerprint = `${model.id} ${model.name} ${model.family} ${model.api.id}`.toLowerCase()
  if (model.api.npm === "@ai-sdk/anthropic" || fingerprint.includes("claude")) return "Claude"
  if (model.api.npm === "@ai-sdk/google" || fingerprint.includes("gemini")) return "Gemini"
  if (
    model.api.npm === "@ai-sdk/github-copilot" ||
    model.api.npm === "@ai-sdk/openai" ||
    fingerprint.includes("gpt") ||
    fingerprint.includes("codex")
  )
    return "GPT"
  if (fingerprint.includes("microsoft") || fingerprint.includes("mai") || fingerprint.includes("raptor"))
    return "Microsoft"
  if (model.family?.trim()) {
    return model.family
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ")
  }
  const npm = model.api.npm.split("/").pop()?.replace(/^@/, "")
  return npm ? npm[0].toUpperCase() + npm.slice(1) : undefined
}

function defaultAutoName(draft: AutoDraft, model?: Model): string {
  if (draft.legacy) return "Auto"
  const label = familyLabel(model)
  return label ? `Auto ${label}` : `Auto ${draft.index}`
}

function defaultAutoID(draft: AutoDraft, model?: Model): string {
  if (draft.legacy) return MODEL_ID
  if (draft.requestedName) return slugify(draft.requestedName)
  const label = familyLabel(model)
  return label ? `auto-${slugify(label)}` : `auto-${draft.index}`
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
  logReady ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
  void logReady.then(() => appendFile(file, `${new Date().toISOString()} info ${msg}\n`).catch(() => undefined))
}

// --- module state -----------------------------------------------------------------------
// Auth/catalog-derived (same for every conversation):
let autoBearer: string | undefined
let autoKnownModels: Model[] = []

function capiBase(url: string) {
  const clean = url.replace(/\/+$/, "")
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean
}

// Headers VS Code attaches to the auto-mode CAPI calls. Verified against
// `@vscode/copilot-api`'s `_mixinHeaders`: every gated request (AutoModels,
// ModelRouter, chat) ALWAYS carries Editor-Version, Editor-Plugin-Version and
// Copilot-Integration-Id — VS Code never omits them.
//
// Copilot-Integration-Id is the *gate*. Its value is a cascade: an unlicensed /
// open-source build sends "code-oss"; a licensed prod build sends "vscode-chat"
// (and a dev build "vscode-chat-dev" + a Request-Hmac). So "code-oss" is the
// honest, non-impersonating baseline — the minimum a real VS Code OSS build sends,
// and the value to try first if /models/session/intent 404s. We keep these lines
// commented to test the truly minimal set first, then add them back one by one.
function copilotHeaders(bearer: string, sessionToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    // "Editor-Version": EDITOR_VERSION, // always sent by VS Code; uncomment with the consts above
    // "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "VScode-SessionId": VSCODE_SESSION_ID,
    "VScode-MachineId": VSCODE_MACHINE_ID,
    "Editor-Device-Id": VSCODE_DEVICE_ID,
    // "Copilot-Integration-Id": "code-oss", // GATE: honest OSS-build value; "vscode-chat" impersonates licensed VS Code
  }
  if (sessionToken) headers["Copilot-Session-Token"] = sessionToken
  return headers
}

// POST /models/session — opens an auto session: returns the candidate pool, a
// session token (drives the auto billing/rate-limit pool + discount), and
// (undocumented) a default selected_model. Pure network call, no caching.
async function fetchAutoSession(baseURL: string, bearer: string): Promise<AutoSession | undefined> {
  const now = Date.now()
  const response = await fetch(`${baseURL}/models/session`, {
    method: "POST",
    headers: copilotHeaders(bearer),
    body: JSON.stringify({ auto_mode: { model_hints: [MODEL_ID] } }),
  }).catch((error) => {
    log(`auto session fetch failed: ${String(error)}`)
    return undefined
  })

  if (!response) return undefined
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    log(`auto session fetch non-ok: ${response.status} ${body}`)
    return undefined
  }

  const data = (await response.json().catch(() => undefined)) as
    | {
        selected_model?: unknown
        session_token?: unknown
        available_models?: unknown
        discounted_costs?: unknown
        expires_at?: unknown
      }
    | undefined

  if (!data || typeof data.session_token !== "string") {
    log("auto session fetch invalid payload (missing session_token)")
    return undefined
  }

  const availableModels = Array.isArray(data.available_models)
    ? (data.available_models.filter((m) => typeof m === "string") as string[])
    : []
  const selectedModelID = typeof data.selected_model === "string" ? data.selected_model : availableModels[0]
  if (!selectedModelID) {
    log("auto session fetch invalid payload (no selected_model and no available_models)")
    return undefined
  }
  const discountedCosts =
    data.discounted_costs && typeof data.discounted_costs === "object"
      ? (data.discounted_costs as Record<string, number>)
      : {}
  const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : now + 30 * 60_000

  log(
    `auto session parsed: selected_model=${selectedModelID}, available_models=[${availableModels.join(", ")}], discounted_costs=${JSON.stringify(discountedCosts)}`,
  )
  return { selectedModelID, sessionToken: data.session_token, availableModels, discountedCosts, expiresAtMs }
}

// POST /models/session/intent — the router. This is the only call that sees the
// prompt; it returns a ranked candidate list. Gated to first-party clients via
// Copilot-Integration-Id, so without that header it may 404 (logged for inspection).
async function getRouterDecision(
  baseURL: string,
  bearer: string,
  sessionToken: string,
  prompt: string,
  availableModels: string[],
  context: Record<string, unknown>,
): Promise<RouterDecision | undefined> {
  const body = { prompt, available_models: availableModels, ...context }
  log(`intent request: ${JSON.stringify(body)}`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), INTENT_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseURL}/models/session/intent`, {
      method: "POST",
      headers: copilotHeaders(bearer, sessionToken),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      log(`intent fetch non-ok: ${response.status} ${text}`)
      return undefined
    }
    const data = (await response.json().catch(() => undefined)) as RouterDecision | undefined
    log(`intent response: ${JSON.stringify(data)}`)
    return data
  } catch (error) {
    log(`intent fetch failed: ${String(error)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// The cloned `auto` model points at ONE endpoint (template's npm + url). We can only
// override the model id (chat.params), not the endpoint, so every model we route to
// must share that endpoint family (cross-family would need a proxy — out of scope).
function modelByApiId(apiId: string): Model | undefined {
  return autoKnownModels.find((m) => m.providerID === PROVIDER_ID && m.api.id === apiId)
}

function isSameFamily(apiId: string | undefined, templateApi?: TemplateAPI): boolean {
  if (!apiId || !templateApi) return false
  if (apiId === templateApi.id) return true
  const model = modelByApiId(apiId)
  return !!model && model.api.npm === templateApi.npm && model.api.url === templateApi.url
}

// Models of a given SDK family present in the auto pool. The within-family router needs
// ≥2 (a strong + a fast tier) to have anything to choose between.
function poolFamilyCount(npm: string, url: string, pool: string[]): number {
  return pool.filter((id) => {
    const model = modelByApiId(id)
    return !!model && model.api.npm === npm && model.api.url === url
  }).length
}

// Mirror VS Code's provider-stickiness: take the first candidate in our endpoint family.
function pickSameFamilyCandidate(candidates: string[], preferredApiIDs: string[], templateApi?: TemplateAPI): string | undefined {
  const sameFamily = candidates.filter((candidate) => isSameFamily(candidate, templateApi))
  if (!sameFamily.length) return undefined
  for (const preferred of preferredApiIDs) {
    if (sameFamily.includes(preferred)) return preferred
  }
  return sameFamily[0]
}

// Mirror VS Code's _selectDefaultModel: when the router is skipped/fails, the default
// is the first model in the session pool (available_models) that resolves to a known
// endpoint — in our case, the first one in the anchored family. VS Code derives the
// default purely from available_models and never reads the undocumented selected_model.
function defaultPoolModel(pool: string[], templateApi?: TemplateAPI): string | undefined {
  return pool.find((id) => isSameFamily(id, templateApi))
}

function preferredPoolModel(pool: string[], preferredApiIDs: string[], templateApi?: TemplateAPI): string | undefined {
  for (const preferred of preferredApiIDs) {
    if (pool.includes(preferred) && isSameFamily(preferred, templateApi)) return preferred
  }
  return undefined
}

// Map the router's reasoning verdict to a provider-native effort knob for the routed
// model, in the same flat shape opencode's effort *variants* use (merged into options).
// Boost-only: raise effort when the prompt needs reasoning and the model supports it;
// leave fast turns at the model default (the router already picks a fast model there).
function reasoningOptions(apiId: string, label: ConvState["routedLabel"]): Record<string, unknown> | undefined {
  if (label !== "needs_reasoning") return undefined
  const model = modelByApiId(apiId)
  if (!model || !model.capabilities?.reasoning) return undefined
  if (model.api.npm === "@ai-sdk/anthropic") {
    // Anthropic SDK uses an extended-thinking budget (opencode uses 16000 for "high").
    return { thinking: { type: "enabled", budgetTokens: 16000 } }
  }
  if (model.api.npm === "@ai-sdk/github-copilot" || model.api.npm === "@ai-sdk/openai") {
    // Match opencode's GPT/Copilot reasoning extras.
    return { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
  }
  return undefined
}

function configuredLabelForModel(auto: InjectedAuto, apiId: string): ConvState["routedLabel"] | undefined {
  if (auto.reasoningApiIDs.includes(apiId)) return "needs_reasoning"
  if (auto.noReasoningApiIDs.includes(apiId)) return "no_reasoning"
  return undefined
}

function configuredModelForLabel(auto: InjectedAuto, label: ConvState["routedLabel"]): string | undefined {
  const labelPrefs =
    label === "needs_reasoning" ? auto.reasoningApiIDs
    : label === "no_reasoning" ? auto.noReasoningApiIDs
    : []
  for (const preferred of labelPrefs) {
    if (isSameFamily(preferred, auto.templateApi)) return preferred
  }
  for (const preferred of auto.preferredApiIDs) {
    if (isSameFamily(preferred, auto.templateApi)) return preferred
  }
  return auto.catalogDefaultModelID ?? auto.templateApi?.id
}

function withAutoModels(models: Record<string, Model>, autos: InjectedAuto[]) {
  const injected = { ...models }
  for (const auto of autos) {
    const template = auto.template ?? pickTemplate(models)
    if (!template) continue
    if (injected[auto.id]) {
      if (auto.id !== MODEL_ID) log(`skip inject ${auto.id}: model id already exists`)
      continue
    }

    // Copy the template's api (id, npm, url) exactly — they already point to the right endpoint.
    // Claude models: url="…/v1" + npm="@ai-sdk/anthropic" → appends /messages → correct.
    // GPT models:   url="…"    + npm="@ai-sdk/github-copilot" → appends /chat/completions → correct.
    // Do NOT strip /v1 from the url; the Anthropic SDK appends /messages (not /v1/messages).
    log(`injected ${auto.id} (${auto.name}) -> ${template.id} (api.id=${template.api.id}, npm=${template.api.npm}, url=${template.api.url})`)
    injected[auto.id] = {
      ...template,
      id: auto.id,
      name: auto.name,
      family: "github-copilot-auto",
      variants: undefined,
    }
  }
  return injected
}

const CopilotAutoModelPlugin: Plugin = async ({ client }, options) => {
  const opts = (options ?? {}) as Options
  const drafts = autoDrafts(opts)
  const conversations = new Map<string, Map<string, ConvState>>()
  let injectedAutos: InjectedAuto[] = []
  let injectedAutoByID = new Map<string, InjectedAuto>()

  function getConv(sessionID: string, autoID: string): ConvState {
    let sessionAutos = conversations.get(sessionID)
    if (!sessionAutos) {
      sessionAutos = new Map<string, ConvState>()
      conversations.set(sessionID, sessionAutos)
    }
    let conv = sessionAutos.get(autoID)
    if (!conv) {
      conv = { turn: 0 }
      sessionAutos.set(autoID, conv)
    }
    return conv
  }

  async function ensureSession(sessionID: string, autoID: string): Promise<AutoSession | undefined> {
    const auto = injectedAutoByID.get(autoID)
    if (!autoBearer || !auto?.templateApi) return undefined
    const conv = getConv(sessionID, autoID)
    if (conv.session && Date.now() < conv.session.expiresAtMs - SESSION_REFRESH_SKEW_MS) return conv.session
    if (!conv.sessionInflight) {
      const baseURL = capiBase(auto.templateApi.url)
      const bearer = autoBearer
      conv.sessionInflight = fetchAutoSession(baseURL, bearer)
        .then((session) => {
          if (session) conv.session = session
          return conv.session
        })
        .finally(() => {
          conv.sessionInflight = undefined
        })
    }
    return conv.sessionInflight
  }

  // The status bar can't show the per-turn route, so surface it as a transient toast
  // whenever the model is (re)picked. Fire-and-forget; never let it break a turn.
  const toast = (message: string, variant: "info" | "success" | "warning" | "error") => {
    try {
      void Promise.resolve(client.tui.showToast({ body: { message, variant } })).catch(() => {})
    } catch {
      /* ignore */
    }
  }
  return {
    // After compaction the conversation shape changed, so re-run the router on the
    // next turn (mirrors VS Code's invalidateRouterCache).
    event: async ({ event }) => {
      if (event.type !== "session.compacted") return
      const autos = conversations.get(event.properties.sessionID)
      if (autos?.size) {
        for (const conv of autos.values()) conv.needsReEval = true
        log(`route invalidated by compaction for ${event.properties.sessionID}`)
      }
    },
    // Capture the prompt text per conversation; chat.params has the message but
    // not its parts, so we stash the text here for the router call.
    "chat.message": async (input, output) => {
      const text = output.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n")
        .trim()
      const references = output.parts.filter((p) => p.type === "file").length
      let autos = conversations.get(input.sessionID)
      if (!autos?.size) {
        autos = new Map<string, ConvState>()
        conversations.set(input.sessionID, autos)
      }
      for (const autoID of injectedAutoByID.keys()) {
        const conv = getConv(input.sessionID, autoID)
        conv.lastPrompt = text
        conv.referenceCount = references
      }
    },
    "chat.params": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      const auto = injectedAutoByID.get(incoming.model.id)
      if (!auto) return

      const conv = getConv(incoming.sessionID, auto.id)
      const session = await ensureSession(incoming.sessionID, auto.id) // refresh token on the turn
      // Default to the first same-family model in the pool (VS Code's _selectDefaultModel),
      // not the undocumented selected_model — kept only as a hint behind it. Everything here
      // is clamped to the cloned endpoint's family (catalogDefaultModelID / templateApi.id
      // always are; the session's selected pick may drift to another family).
      let decided =
        preferredPoolModel(session?.availableModels ?? [], auto.preferredApiIDs, auto.templateApi) ??
        defaultPoolModel(session?.availableModels ?? [], auto.templateApi) ??
        (isSameFamily(session?.selectedModelID, auto.templateApi) ? session?.selectedModelID : undefined) ??
        auto.catalogDefaultModelID ??
        auto.templateApi?.id
      const prompt = conv.lastPrompt
      const sessionMissingConfiguredPrefs =
        !!session && auto.preferredApiIDs.length > 0 && !auto.preferredApiIDs.some((id) => session.availableModels.includes(id))
      if (sessionMissingConfiguredPrefs && auto.catalogDefaultModelID) {
        conv.omitSessionToken = true
        if (conv.routedModelID !== undefined && !conv.needsReEval) {
          // Sticky: reuse the first turn's pick so the model — and its prompt KV cache —
          // stays stable across turns, matching the main routing path and VS Code (which
          // skips routing once turnCount > 0). Re-evaluated only after compaction.
          decided = conv.routedModelID
        } else {
          let decision: RouterDecision | undefined
          if (session.sessionToken && prompt && autoBearer && auto.templateApi && session.availableModels.length) {
            const context = {
              session_id: incoming.sessionID,
              turn_number: conv.turn + 1,
              previous_model: conv.previousModel,
              reference_count: conv.referenceCount,
              prompt_char_count: prompt.length,
            }
            decision = await getRouterDecision(
              capiBase(auto.templateApi.url),
              autoBearer,
              session.sessionToken,
              prompt,
              session.availableModels,
              context,
            )
          }
          const routedLabel = decision?.predicted_label ?? configuredLabelForModel(auto, auto.catalogDefaultModelID)
          decided = configuredModelForLabel(auto, routedLabel) ?? auto.catalogDefaultModelID
          if (decided !== conv.routedModelID || routedLabel !== conv.routedLabel) {
            toast(
              `${auto.name} → ${decided}${routedLabel ? ` · ${routedLabel}` : " · configured"}`,
              routedLabel === "needs_reasoning" ? "success" : "info",
            )
          }
          conv.routedModelID = decided
          conv.routedLabel = routedLabel
          conv.needsReEval = false
          log(`session pool lacks configured models for ${auto.id}; using ${decided} without Copilot-Session-Token`)
        }
      } else {
        conv.omitSessionToken = false
      }

      if (session?.sessionToken && prompt && autoBearer && auto.templateApi && !sessionMissingConfiguredPrefs) {
        if (!session.availableModels.length) {
          log("intent skipped: session returned no available_models")
        } else if (conv.routedModelID !== undefined && !conv.needsReEval) {
          // Stick with the first turn's pick (re-evaluated only on compaction) so the
          // model — and therefore the prompt KV cache — stays stable across turns.
          // Matches VS Code's automode router, which skips routing once turnCount > 0.
          decided = conv.routedModelID
        } else {
          const context = {
            session_id: incoming.sessionID,
            turn_number: conv.turn + 1,
            previous_model: conv.previousModel,
            reference_count: conv.referenceCount,
            prompt_char_count: prompt.length,
          }
          const decision = await getRouterDecision(
            capiBase(auto.templateApi.url),
            autoBearer,
            session.sessionToken,
            prompt,
            session.availableModels,
            context,
          )
          const candidates = decision?.candidate_models ?? []
          if (candidates.length) {
            // Use label-specific preferences when available; fall back to general list.
            const label = decision?.predicted_label
            const labelPrefs =
              label === "needs_reasoning" ? auto.reasoningApiIDs
              : label === "no_reasoning" ? auto.noReasoningApiIDs
              : auto.preferredApiIDs
            const effectivePrefs = labelPrefs.length ? labelPrefs : auto.preferredApiIDs
            const sameFamily = pickSameFamilyCandidate(candidates, effectivePrefs, auto.templateApi)
            if (sameFamily) {
              decided = sameFamily
              log(
                `intent routed -> ${decided} (top=${candidates[0]}, label=${label}, confidence=${decision?.confidence})`,
              )
            } else {
              log(`intent top=${candidates[0]} not same-family as ${auto.templateApi?.id}; keeping ${decided}`)
            }
          }
          if (decided && decided !== conv.routedModelID) {
            const reasoning = decision?.predicted_label === "needs_reasoning"
            toast(
              `${auto.name} → ${decided}${decision?.predicted_label ? ` · ${decision.predicted_label}` : ""}`,
              reasoning ? "success" : "info",
            )
          }
          conv.routedModelID = decided
          conv.routedLabel = decision?.predicted_label
          conv.needsReEval = false
        }
      }

      conv.turn = conv.turn + 1

      if (decided && decided !== incoming.model.id) {
        output.options.model = decided
        conv.previousModel = decided
        log(`chat.params override ${auto.id} -> ${decided}`)
        // Apply the routed reasoning effort every turn (sticky turns reuse routedLabel)
        // so it stays consistent with the model across the conversation.
        const effort = reasoningOptions(decided, conv.routedLabel)
        if (effort) {
          Object.assign(output.options, effort)
          log(`reasoning effort -> ${JSON.stringify(effort)} for ${decided}`)
        }
      }
    },
    "chat.headers": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      const auto = injectedAutoByID.get(incoming.model.id)
      if (!auto) return
      const conv = getConv(incoming.sessionID, auto.id)
      if (conv.omitSessionToken) return
      const session = await ensureSession(incoming.sessionID, auto.id)
      if (!session?.sessionToken) return
      output.headers["Copilot-Session-Token"] = session.sessionToken
      log(`chat.headers added Copilot-Session-Token for ${auto.id}`)
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        autoKnownModels = Object.values(provider.models)
        autoBearer = ctx.auth?.type === "oauth" ? ctx.auth.refresh : undefined
        const sessionCache = new Map<string, Promise<AutoSession | undefined>>()
        const usedIDs = new Set<string>([...Object.keys(provider.models), MODEL_ID])
        const usedNames = new Set<string>(["Auto"])
        const resolvedAutos: InjectedAuto[] = []

        for (const draft of drafts) {
          const preferredApiIDs = resolvePreferredApiIDs(provider.models, draft.preferredModels)
          const reasoningApiIDs = resolvePreferredApiIDs(provider.models, draft.reasoning)
          const noReasoningApiIDs = resolvePreferredApiIDs(provider.models, draft.noReasoning)
          let template = pickTemplate(provider.models)
          const preferredTemplate = preferredApiIDs.map(modelByApiId).find((model): model is Model => !!model)
          if (preferredTemplate) {
            template = preferredTemplate
            log(`preference anchor${draft.legacy ? "" : ` (${draft.requestedName ?? draft.requestedID ?? draft.index})`} -> ${preferredTemplate.api.id}`)
          }

          if (template && ctx.auth?.type === "oauth") {
            const baseURL = capiBase(template.api.url)
            const sessionCacheKey = `${template.api.npm}\n${baseURL}`
            let sessionPromise = sessionCache.get(sessionCacheKey)
            if (!sessionPromise) {
              // Catalog-level session only chooses the injected model's endpoint family
              // + fallback default; each conversation still opens its own session.
              sessionPromise = fetchAutoSession(baseURL, ctx.auth.refresh)
              sessionCache.set(sessionCacheKey, sessionPromise)
            }
            const session = await sessionPromise
            if (session) {
              const preferredInPool = preferredApiIDs.find((id) => session.availableModels.includes(id))
              if (preferredInPool) {
                const preferredModel = modelByApiId(preferredInPool)
                if (preferredModel) {
                  template = preferredModel
                  log(`preference session pick${draft.legacy ? "" : ` (${draft.requestedName ?? draft.requestedID ?? draft.index})`} -> ${preferredModel.api.id}`)
                }
              } else if (!preferredTemplate) {
                template = modelByApiId(session.selectedModelID) ?? template
              }
              // Guard: if the selected model's family has no fast/strong pair in the pool,
              // the within-family router can't do anything — anchor on a family that does
              // (still a genuine Copilot auto model from the pool).
              if (!preferredTemplate && !preferredInPool && poolFamilyCount(template.api.npm, template.api.url, session.availableModels) < 2) {
                const richer = session.availableModels
                  .map(modelByApiId)
                  .find((model) => model && poolFamilyCount(model.api.npm, model.api.url, session.availableModels) >= 2)
                if (richer) {
                  log(`family guard: ${template.api.id}'s family has <2 pool models; anchoring on ${richer.api.id}`)
                  template = richer
                }
              }
            }
          }

          const baseName = draft.requestedName || defaultAutoName(draft, template)
          const baseID = draft.requestedID || defaultAutoID(draft, template)
          const name = draft.legacy ? "Auto" : uniqueValue(baseName, usedNames, " ")
          const id = draft.legacy ? MODEL_ID : uniqueValue(baseID, usedIDs)
          resolvedAutos.push({
            id,
            name,
            preferredModels: draft.preferredModels,
            reasoning: draft.reasoning,
            noReasoning: draft.noReasoning,
            preferredApiIDs,
            reasoningApiIDs,
            noReasoningApiIDs,
            template,
            templateApi: template ? templateAPI(template) : undefined,
            catalogDefaultModelID: template?.api.id,
          })
        }

        injectedAutos = resolvedAutos.filter((auto) => !!auto.template)
        injectedAutoByID = new Map(injectedAutos.map((auto) => [auto.id, auto]))
        return withAutoModels(provider.models, injectedAutos)
      },
    },
  }
}

export default { server: CopilotAutoModelPlugin, id: "opencode-github-copilot-auto-model" }
