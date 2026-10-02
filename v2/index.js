// V2 port of m0wer/opencode-github-copilot-auto-model (v0.2.0, V1-only).
// Original: V1 plugin exporting { id, server } with provider.models / chat.params / chat.headers.
// V2 requires `export default { id, setup(ctx) }` with ctx.provider.transform + ctx.session.hook.
// This port keeps the same Copilot auto-session + intent-router behavior,
// but defaults AutoGPT to GPT-5.6 Luna per user request.
//
// Picker models injected:
//   - auto (legacy Auto, anchored on preferences or session pick)
//   - auto-claude (Auto Claude, family-clamped)
//   - auto-gpt (Auto GPT, family-clamped, Luna-first)
// Extra `autos` option replaces defaults (same semantics as upstream).

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const MODEL_ID = "auto"
const PROVIDER_ID = "github-copilot"
const COPILOT_API_VERSION = "2026-06-01"
// AutoV2 router (PI approach, what current VS Code uses): single POST /auto.
// Legacy /models/session pool lacks Luna (5 models); /auto returns Luna natively.
const AUTO_V2_API_VERSION = "2026-08-01"
const AUTO_V2_TIMEOUT_MS = 5000
const AUTO_V2_BASE_URL = "https://api.individual.githubcopilot.com"
const INTENT_TIMEOUT_MS = 1000
const SESSION_REFRESH_SKEW_MS = 60_000

// Luna-first defaults for the GPT family (user request: GPT 5.6 Luna as AutoGPT route).
// Kept in sync with models.dev catalog + live /models (both contain these IDs).
const LUNA_DEFAULTS = [
  "gpt-5.6-luna",
  "gpt-5.6-luna-utility",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]

const VSCODE_SESSION_ID = `${randomUUID()}${Date.now()}`
const VSCODE_MACHINE_ID = randomUUID().replace(/-/g, "")
const VSCODE_DEVICE_ID = randomUUID()

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

let logReady
function log(msg) {
  try {
    const file = logFile()
    logReady ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
    void logReady.then(() => appendFile(file, `${new Date().toISOString()} info [v2-luna] ${msg}\n`).catch(() => undefined))
  } catch {}
}

function normalizeList(values) {
  if (!values?.length) return []
  const out = []
  for (const v of values) {
    const s = String(v).trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function uniqueValue(base, used, suffix = "-") {
  let value = base || "auto"
  let counter = 2
  while (used.has(value)) {
    value = `${base}${suffix}${counter}`
    counter += 1
  }
  used.add(value)
  return value
}

// V2 Model.Info shape: { id, modelID, providerID, family, name, ... }
// V1 used model.api.id/npm/url; V2 uses family + package. Luna fingerprint must stay GPT.
function familyLabel(model) {
  if (!model) return undefined
  const fingerprint = `${model.id ?? ""} ${model.modelID ?? ""} ${model.name ?? ""} ${model.family ?? ""}`.toLowerCase()
  if (fingerprint.includes("claude")) return "Claude"
  if (fingerprint.includes("gemini")) return "Gemini"
  if (fingerprint.includes("microsoft") || fingerprint.includes("mai-") || fingerprint.includes("mai ") || fingerprint.includes("raptor")) return "Microsoft"
  if (fingerprint.includes("gpt") || fingerprint.includes("codex") || fingerprint.includes("luna") || fingerprint.includes("sol") || fingerprint.includes("terra") || fingerprint.includes("astra")) return "GPT"
  if (model.family?.trim()) {
    const parts = model.family.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1))
    if (parts.length) return parts.join(" ")
  }
  return undefined
}

function pickTemplate(models, familyFilter) {
  const list = Array.isArray(models) ? models : Object.values(models)
  return list.find((m) => m?.providerID === PROVIDER_ID && (!familyFilter || familyLabel(m) === familyFilter))
}

// Resolve user tokens (OpenCode id or provider modelID) to OpenCode ids.
function resolvePreferredIds(allModels, preferred) {
  const resolved = []
  const entries = (Array.isArray(allModels) ? allModels : Object.values(allModels)).filter((m) => m?.providerID === PROVIDER_ID)
  const byId = new Map(entries.map((m) => [m.id, m]))
  const byModelID = new Map(entries.map((m) => [m.modelID ?? m.id, m]))
  for (const token of preferred) {
    const hit = byId.get(token) ?? byModelID.get(token)
    if (hit && !resolved.includes(hit.id)) resolved.push(hit.id)
  }
  return resolved
}

const DEFAULT_AUTO_FAMILIES = ["Claude", "GPT"]

function defaultFamilyDrafts(allModels) {
  const list = Array.isArray(allModels) ? allModels : Object.values(allModels)
  const counts = new Map()
  for (const model of list) {
    if (model?.providerID !== PROVIDER_ID) continue
    const label = familyLabel(model)
    if (!label) continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const drafts = []
  for (const [index, label] of DEFAULT_AUTO_FAMILIES.entries()) {
    if ((counts.get(label) ?? 0) < 2) {
      // Luna fallback: if GPT family has at least Luna + one other (or even 1 when
      // sync is degraded), still inject Auto GPT so the Luna route is selectable.
      // Require >=1 for GPT to survive Copilot sync timeouts with explicit config.
      if (!(label === "GPT" && (counts.get(label) ?? 0) >= 1)) continue
    }
    const draft = {
      preferredModels: [],
      reasoning: [],
      noReasoning: [],
      legacy: false,
      index: index + 1,
      familyFilter: label,
    }
    // Luna-first for AutoGPT default (user request).
    if (label === "GPT") {
      draft.preferredModels = [...LUNA_DEFAULTS]
      draft.reasoning = ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.5", "gpt-5.4"]
      draft.noReasoning = ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.3-codex"]
    }
    drafts.push(draft)
  }
  return drafts
}

function autoDrafts(options, allModels) {
  const drafts = [
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
  if (options.autos === undefined) {
    drafts.push(...defaultFamilyDrafts(allModels))
    return drafts
  }
  for (const [index, auto] of options.autos.entries()) {
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

function defaultAutoName(draft, model) {
  if (draft.legacy) return "Auto"
  const label = familyLabel(model)
  return label ? `Auto ${label}` : `Auto ${draft.index}`
}

function defaultAutoID(draft, model) {
  if (draft.legacy) return MODEL_ID
  if (draft.requestedName) return slugify(draft.requestedName)
  const label = familyLabel(model)
  return label ? `auto-${slugify(label)}` : `auto-${draft.index}`
}

function capiBase(url) {
  const clean = String(url || "https://api.githubcopilot.com").replace(/\/+$/, "")
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean
}

function copilotHeaders(bearer, sessionToken) {
  const headers = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    "VScode-SessionId": VSCODE_SESSION_ID,
    "VScode-MachineId": VSCODE_MACHINE_ID,
    "Editor-Device-Id": VSCODE_DEVICE_ID,
  }
  if (sessionToken) headers["Copilot-Session-Token"] = sessionToken
  return headers
}

async function fetchAutoSession(baseURL, bearer) {
  const now = Date.now()
  let response
  try {
    response = await fetch(`${baseURL}/models/session`, {
      method: "POST",
      headers: copilotHeaders(bearer),
      body: JSON.stringify({ auto_mode: { model_hints: [MODEL_ID] } }),
    })
  } catch (error) {
    log(`auto session fetch failed: ${String(error)}`)
    return undefined
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    log(`auto session fetch non-ok: ${response.status} ${body.slice(0, 500)}`)
    return undefined
  }
  const data = await response.json().catch(() => undefined)
  if (!data || typeof data.session_token !== "string") {
    log("auto session fetch invalid payload (missing session_token)")
    return undefined
  }
  const availableModels = Array.isArray(data.available_models) ? data.available_models.filter((m) => typeof m === "string") : []
  const selectedModelID = typeof data.selected_model === "string" ? data.selected_model : availableModels[0]
  if (!selectedModelID) {
    log("auto session fetch invalid payload (no selected_model)")
    return undefined
  }
  const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : now + 30 * 60_000
  log(`auto session parsed: selected=${selectedModelID}, pool=[${availableModels.slice(0, 12).join(", ")}${availableModels.length > 12 ? ", …" : ""}] (${availableModels.length})`)
  return { selectedModelID, sessionToken: data.session_token, availableModels, expiresAtMs }
}

async function getRouterDecision(baseURL, bearer, sessionToken, prompt, availableModels, context) {
  const body = { prompt, available_models: availableModels, ...context }
  log(`intent request: ${JSON.stringify(body).slice(0, 800)}`)
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
      log(`intent fetch non-ok: ${response.status} ${text.slice(0, 500)}`)
      return undefined
    }
    const data = await response.json().catch(() => undefined)
    log(`intent response: ${JSON.stringify(data).slice(0, 800)}`)
    return data
  } catch (error) {
    log(`intent fetch failed: ${String(error)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function resolveBearer(ctx) {
  // 1) V2 integration connection (preferred).
  try {
    const conn = await ctx.integration.connection.active("github-copilot")
    if (conn) {
      const cred = await ctx.integration.connection.resolve(conn)
      // Credential.Value is { type, ... }; oauth has refresh/access.
      const token = cred?.refresh ?? cred?.access ?? cred?.token ?? cred?.key
      if (typeof token === "string" && token.length > 10) return token
      // Some shapes nest under credential.value
      const nested = cred?.value?.refresh ?? cred?.value?.access
      if (typeof nested === "string" && nested.length > 10) return nested
    }
  } catch (e) {
    log(`bearer via integration failed: ${String(e).slice(0, 200)}`)
  }
  // 2) Fallback: read auth.json directly (same file `opencode auth` uses).
  try {
    const authPath = path.join(homedir(), ".local", "share", "opencode", "auth.json")
    const raw = await readFile(authPath, "utf8")
    const auth = JSON.parse(raw)
    const token = auth?.["github-copilot"]?.refresh ?? auth?.["github-copilot"]?.access
    if (typeof token === "string" && token.length > 10) {
      log("bearer via auth.json fallback")
      return token
    }
  } catch (e) {
    log(`bearer via auth.json failed: ${String(e).slice(0, 200)}`)
  }
  return undefined
}

// AutoV2 router headers (PI approach): full VS Code identity, API version 2026-08-01.
function autoV2Headers(bearer) {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": AUTO_V2_API_VERSION,
    "User-Agent": "GitHubCopilotChat/0.43.0",
    "Editor-Version": "vscode/1.134.0",
    "Editor-Plugin-Version": "copilot-chat/0.43.0",
    "Copilot-Integration-Id": "vscode-chat",
    "VScode-SessionId": VSCODE_SESSION_ID,
    "VScode-MachineId": VSCODE_MACHINE_ID,
    "Editor-Device-Id": VSCODE_DEVICE_ID,
  }
}

// Single-call AutoV2 router: picks model + mints session token in one round-trip.
// Returns { selectedId, sessionToken, expiresAtMs }. Tier biases selection;
// verified live: code prompt + any tier -> gpt-5.6-luna; trivial hi + max -> luna.
async function fetchAutoV2Decision(bearer, prompt, tier) {
  const body = { prompt }
  if (tier) body.tier = tier
  log(`autov2 request tier=${tier} prompt=${JSON.stringify(prompt).slice(0, 120)}`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), AUTO_V2_TIMEOUT_MS)
  try {
    const response = await fetch(`${AUTO_V2_BASE_URL}/auto`, {
      method: "POST",
      headers: autoV2Headers(bearer),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      log(`autov2 non-ok: ${response.status} ${text.slice(0, 300)}`)
      return undefined
    }
    const data = await response.json().catch(() => undefined)
    const selectedId = data?.selected_model?.id
    const sessionToken = data?.session_token
    if (typeof selectedId !== "string" || typeof sessionToken !== "string") {
      log(`autov2 bad payload: ${JSON.stringify(data).slice(0, 300)}`)
      return undefined
    }
    const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 24 * 3600_000
    log(`autov2 tier=${tier} selected=${selectedId}`)
    return { selectedId, sessionToken, expiresAtMs }
  } catch (e) {
    log(`autov2 fetch failed: ${String(e).slice(0, 200)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// Tier per auto: Luna-specific autos use max (verified Luna-biased live),
// generic autos use balanced (VS Code default).
function tierForAuto(auto) {
  const id = String(auto?.id ?? "").toLowerCase()
  const anchor = String(auto?.anchorId ?? "").toLowerCase()
  if (id.includes("luna") || anchor.includes("luna")) return "max"
  return "balanced"
}

export default {
  id: "github-copilot-auto-luna",
  async setup(ctx) {
    const opts = (ctx.options ?? {})
    const conversations = new Map() // sessionID -> Map(autoID -> ConvState)
    let injectedAutos = []
    let injectedAutoByID = new Map()
    let knownModelsById = new Map() // OpenCode id -> Model.Info
    let knownModelsByModelID = new Map() // provider modelID -> Model.Info
    let bearerCache = undefined
    let bearerLoaded = false

    async function getBearer() {
      if (bearerLoaded) return bearerCache
      bearerCache = await resolveBearer(ctx)
      bearerLoaded = true
      if (!bearerCache) log("WARNING: no github-copilot bearer; auto routing will use catalog fallback without session token")
      return bearerCache
    }

    function modelById(id) {
      return knownModelsById.get(id) ?? knownModelsByModelID.get(id)
    }

    function matchesFamily(modelId, familyFilter) {
      if (!familyFilter) return true
      const m = modelById(modelId)
      return !!m && familyLabel(m) === familyFilter
    }

    function isSameFamilyId(modelId, anchorId) {
      if (!modelId || !anchorId) return false
      if (modelId === anchorId) return true
      const a = modelById(modelId)
      const b = modelById(anchorId)
      if (!a || !b) {
        // Provider-side ids (session pool / router candidates) usually equal
        // OpenCode ids for Copilot; fall back to string match when unknown.
        return false
      }
      return familyLabel(a) === familyLabel(b)
    }

    function getConv(sessionID, autoID) {
      let m = conversations.get(sessionID)
      if (!m) {
        m = new Map()
        conversations.set(sessionID, m)
      }
      let c = m.get(autoID)
      if (!c) {
        c = { turn: 0 }
        m.set(autoID, c)
      }
      return c
    }

    async function ensureSession(sessionID, auto) {
      const bearer = await getBearer()
      if (!bearer) return undefined
      const conv = getConv(sessionID, auto.id)
      if (conv.session && Date.now() < conv.session.expiresAtMs - SESSION_REFRESH_SKEW_MS) return conv.session
      if (!conv.sessionInflight) {
        const baseURL = capiBase(auto.baseURL)
        conv.sessionInflight = fetchAutoSession(baseURL, bearer)
          .then((s) => {
            if (s) conv.session = s
            return conv.session
          })
          .finally(() => {
            conv.sessionInflight = undefined
          })
      }
      return conv.sessionInflight
    }

    function pickFromPool(pool, preferredIds, anchorId) {
      for (const p of preferredIds) {
        if (pool.includes(p) || pool.includes(modelById(p)?.modelID ?? "")) {
          // normalize to OpenCode id
          const m = modelById(p)
          const openId = m?.id ?? p
          if (isSameFamilyId(openId, anchorId)) return openId
        }
      }
      return pool.map((pid) => modelById(pid)?.id ?? pid).find((oid) => isSameFamilyId(oid, anchorId))
    }

    function configuredLabelForModel(auto, openId) {
      if (auto.reasoningIds.includes(openId)) return "needs_reasoning"
      if (auto.noReasoningIds.includes(openId)) return "no_reasoning"
      return undefined
    }

    function configuredModelForLabel(auto, label) {
      const prefs = label === "needs_reasoning" ? auto.reasoningIds : label === "no_reasoning" ? auto.noReasoningIds : []
      for (const p of prefs) {
        if (isSameFamilyId(p, auto.anchorId)) return p
      }
      for (const p of auto.preferredIds) {
        if (isSameFamilyId(p, auto.anchorId)) return p
      }
      return auto.anchorId
    }

    // ---- build injection list from current provider inventory (sync) ----
    function buildAutos(providerModels) {
      const list = Array.isArray(providerModels) ? providerModels : [...providerModels.values()]
      knownModelsById = new Map(list.filter((m) => m?.providerID === PROVIDER_ID).map((m) => [m.id, m]))
      knownModelsByModelID = new Map()
      for (const m of knownModelsById.values()) {
        if (m.modelID && !knownModelsByModelID.has(m.modelID)) knownModelsByModelID.set(m.modelID, m)
      }
      const drafts = autoDrafts(opts, list.filter((m) => m?.providerID === PROVIDER_ID))
      const usedIDs = new Set([...knownModelsById.keys(), MODEL_ID])
      const usedNames = new Set(["Auto"])
      const resolved = []
      for (const draft of drafts) {
        const preferredIds = resolvePreferredIds(list, draft.preferredModels)
        const reasoningIds = resolvePreferredIds(list, draft.reasoning)
        const noReasoningIds = resolvePreferredIds(list, draft.noReasoning)
        let template = pickTemplate(list, draft.familyFilter)
        const preferredTemplate = preferredIds.map((id) => knownModelsById.get(id)).find(Boolean)
        if (preferredTemplate) {
          // Anchor on explicit preference when it exists in catalog.
          if (!draft.familyFilter || familyLabel(preferredTemplate) === draft.familyFilter) {
            template = preferredTemplate
            log(`preference anchor${draft.legacy ? "" : ` (${draft.requestedName ?? draft.requestedID ?? draft.index})`} -> ${preferredTemplate.id}`)
          }
        }
        // Luna-first: GPT draft with no usable template anchor falls back to Luna when present.
        if (!template && draft.familyFilter === "GPT") {
          template = LUNA_DEFAULTS.map((id) => knownModelsById.get(id)).find(Boolean) ?? pickTemplate(list)
        }
        if (!template && draft.legacy) template = pickTemplate(list)
        if (!template) {
          log(`skip draft ${draft.requestedID ?? draft.index}: no ${draft.familyFilter ?? ""} template in catalog (${knownModelsById.size} copilot models)`)
          continue
        }
        const baseName = draft.requestedName || defaultAutoName(draft, template)
        const baseID = draft.requestedID || defaultAutoID(draft, template)
        const name = draft.legacy ? "Auto" : uniqueValue(baseName, usedNames, " ")
        const id = draft.legacy ? MODEL_ID : uniqueValue(baseID, usedIDs)
        // Luna-first: GPT auto with empty prefs inherits Luna defaults resolved to catalog ids.
        let effPreferred = preferredIds
        let effReasoning = reasoningIds
        let effNoReasoning = noReasoningIds
        if (draft.familyFilter === "GPT" && effPreferred.length === 0) {
          effPreferred = resolvePreferredIds(list, LUNA_DEFAULTS)
        }
        resolved.push({
          id,
          name,
          preferredIds: effPreferred,
          reasoningIds: effReasoning.length ? effReasoning : resolvePreferredIds(list, ["gpt-5.6-luna", "gpt-6-luna"]),
          noReasoningIds: effNoReasoning.length ? effNoReasoning : resolvePreferredIds(list, ["gpt-5.6-luna", "gpt-5.4-mini"]),
          templateId: template.id,
          templateModelID: template.modelID ?? template.id,
          anchorId: template.id,
          baseURL: template.settings?.baseURL ?? "https://api.githubcopilot.com",
          familyFilter: draft.familyFilter,
          // Clone template shape for injection; keep modelID pointing at anchor.
          template,
        })
      }
      return resolved
    }

    function toInjectedModelInfo(auto) {
      const t = auto.template
      return {
        ...t,
        id: auto.id,
        // modelID stays anchored; per-turn routing mutates the Ref id instead.
        modelID: auto.templateModelID,
        name: auto.name,
        family: "github-copilot-auto",
        enabled: true,
        status: "active",
      }
    }

    // Provider transform: inject autos. Synchronous callback per V2 rules.
    const locDir = ctx.location?.directory ?? ctx.location?.project?.directory ?? "unknown-loc"
    await ctx.provider.transform((editor) => {
      const rec = editor.get(PROVIDER_ID)
      const current = rec ? [...rec.models.values()] : []
      const autos = buildAutos(current)
      injectedAutos = autos
      injectedAutoByID = new Map(autos.map((a) => [a.id, a]))
      if (!autos.length) {
        log(`provider.transform loc=${locDir}: no autos (copilot catalog=${current.length})`)
        return
      }
      const merged = [...current]
      for (const auto of autos) {
        if (merged.some((m) => m.id === auto.id)) {
          if (auto.id !== MODEL_ID) log(`skip inject ${auto.id}: id exists`)
          continue
        }
        merged.push(toInjectedModelInfo(auto))
        log(`injected ${auto.id} (${auto.name}) anchor=${auto.anchorId} prefs=[${auto.preferredIds.slice(0, 5).join(", ")}]`)
      }
      try {
        editor.models.set(PROVIDER_ID, merged)
      } catch (e) {
        log(`provider.models.set failed: ${String(e).slice(0, 300)}`)
      }
    })

    // Model transform: enable the full Copilot catalog so /autoV2-selected ids
    // (Luna, mini, mai, …) are selectable Ref targets instead of "Model unavailable".
    // Provider-stage source definitions carry enabled=false for non-entitled live
    // models; flipping them here makes Ref mutation work for router picks.
    await ctx.model.transform((editor) => {
      try {
        let enabledCount = 0
        for (const m of editor.list("github-copilot")) {
          if (m.enabled !== true) {
            editor.update("github-copilot", m.id, (draft) => {
              draft.enabled = true
            })
            enabledCount += 1
          }
        }
        if (enabledCount) log(`model.transform loc=${locDir} enabled ${enabledCount} copilot models`)
        const all = editor.list("github-copilot")
        const ids = all.map((m) => m.id)
        const autoSeen = ids.filter((id) => id === "auto" || id.startsWith("auto-"))
        if (!autoSeen.length) log(`model.transform loc=${locDir} NO autos (injected=${injectedAutos.map((a) => a.id).join(", ")})`)
      } catch (e) {
        log(`model.transform failed: ${String(e).slice(0, 200)}`)
      }
    })

    // Prompt hook (V1 chat.message): stash prompt text per session.
    await ctx.session.hook("prompt", (event) => {
      const text = String(event.prompt?.text ?? "").trim()
      const refs = Array.isArray(event.prompt?.files) ? event.prompt.files.length : 0
      let m = conversations.get(event.sessionID)
      if (!m) {
        m = new Map()
        conversations.set(event.sessionID, m)
      }
      for (const autoID of injectedAutoByID.keys()) {
        const conv = getConv(event.sessionID, autoID)
        conv.lastPrompt = text
        conv.referenceCount = refs
      }
    })

    // Context hook (V1 chat.params): intent routing + model override.
    await ctx.session.hook(
      "context",
      async (event) => {
        if (event.model?.providerID !== PROVIDER_ID) return
        const auto = injectedAutoByID.get(event.model.id)
        if (!auto) return
        const conv = getConv(event.sessionID, auto.id)
        const prompt = (conv.lastPrompt ?? "").trim()
        // --- AutoV2 path first (PI single-call router; only path that returns Luna).
        // Sticky per conversation like VS Code (KV-cache stability).
        // V2 only for Luna-biased autos (tier max); per-model codex / claude autos
        // keep the proven legacy session/intent flow as their baseline.
        const tier = tierForAuto(auto)
        const useV2 = tier === "max"
        const v2fresh =
          conv.autoV2Decision && Date.now() < conv.autoV2Decision.expiresAtMs - SESSION_REFRESH_SKEW_MS && conv.autoV2Tier === tier && !conv.needsReEval
        if (prompt && useV2) {
          let v2 = v2fresh ? conv.autoV2Decision : undefined
          if (!v2) {
            const bearer = await getBearer()
            if (bearer) {
              v2 = (await fetchAutoV2Decision(bearer, prompt, tier)) ?? undefined
              if (v2) {
                conv.autoV2Decision = v2
                conv.autoV2Tier = tier
                conv.needsReEval = false
              }
            }
          }
          if (v2) {
            const target = modelById(v2.selectedId)?.id ?? v2.selectedId
            conv.autoV2Token = v2.sessionToken
            conv.omitSessionToken = true // never mix legacy session token with V2 token
            conv.routedModelID = target
            conv.routedLabel = undefined
            conv.turn += 1
            if (target !== event.model.id) {
              const before = event.model.id
              try {
                event.model.id = target
              } catch {
                event.model = { providerID: PROVIDER_ID, id: target }
              }
              conv.previousModel = target
              log(`autov2 override ${before} -> ${target} (tier=${tier} session ${event.sessionID})`)
            } else {
              log(`autov2 keep ${target} (tier=${tier} session ${event.sessionID})`)
            }
            return // V2 handled; skip legacy session/intent entirely
          }
          log(`autov2 failed for ${auto.id}; falling back to legacy session/intent`)
        }
        const session = await ensureSession(event.sessionID, auto)
        const poolRaw = session?.availableModels ?? []
        // Normalize pool provider ids -> OpenCode ids; clamp to family.
        const pool = poolRaw
          .map((pid) => knownModelsById.get(pid)?.id ?? knownModelsByModelID.get(pid)?.id ?? pid)
          .filter((oid) => matchesFamily(oid, auto.familyFilter) || knownModelsById.has(oid) === false)
          .filter((oid) => (auto.familyFilter ? (knownModelsById.has(oid) ? matchesFamily(oid, auto.familyFilter) : true) : true))
        // Default: preferred-in-pool else first same-family else anchor.
        let decided =
          pickFromPool(poolRaw.map((pid) => knownModelsById.get(pid)?.id ?? pid), auto.preferredIds, auto.anchorId) ??
          pool.find((oid) => isSameFamilyId(oid, auto.anchorId)) ??
          auto.anchorId
        const legacyPrompt = conv.lastPrompt
        const poolHasPrefs = auto.preferredIds.length === 0 || auto.preferredIds.some((id) => poolRaw.includes(id) || poolRaw.includes(knownModelsById.get(id)?.modelID))
        const familyMissing = !!auto.familyFilter && (session?.availableModels?.length ?? 0) > 0 && !pool.some((oid) => isSameFamilyId(oid, auto.anchorId))
        // Luna best-effort: anchor itself not in auto pool (live pool=5 without Luna).
        // Sending Luna WITH session token always 400s ("not available for session"),
        // so route Luna direct without token (same best-effort path V1 uses for Gemini).
        const anchorModelID = knownModelsById.get(auto.anchorId)?.modelID ?? auto.anchorId
        const anchorInPool = !!session && (poolRaw.includes(auto.anchorId) || poolRaw.includes(anchorModelID))
        const anchorMissing = !!session && !!session.availableModels.length && !anchorInPool
        if (anchorMissing) {
          log(`anchor ${auto.anchorId} not in auto pool (${poolRaw.length}); best-effort Luna route without token`)
        }
        const poolExcludesAuto = !!session && (!poolHasPrefs || familyMissing || anchorMissing)

        if (poolExcludesAuto) {
          conv.omitSessionToken = true
          if (conv.routedModelID !== undefined && !conv.needsReEval) {
            decided = conv.routedModelID
          } else {
            let decision
            const bearer = await getBearer()
            if (session?.sessionToken && prompt && bearer && session.availableModels.length) {
              decision = await getRouterDecision(capiBase(auto.baseURL), bearer, session.sessionToken, prompt, session.availableModels, {
                session_id: event.sessionID,
                turn_number: conv.turn + 1,
                previous_model: conv.previousModel,
                reference_count: conv.referenceCount,
                prompt_char_count: prompt.length,
              })
            }
            const label = decision?.predicted_label ?? configuredLabelForModel(auto, auto.anchorId)
            decided = configuredModelForLabel(auto, label) ?? auto.anchorId
            conv.routedModelID = decided
            conv.routedLabel = label
            conv.needsReEval = false
            log(`pool lacks family/prefs for ${auto.id}; fallback ${decided} without token`)
          }
        } else {
          conv.omitSessionToken = false
        }

        if (session?.sessionToken && prompt && !poolExcludesAuto) {
          const bearer = await getBearer()
          if (!session.availableModels.length) {
            log("intent skipped: empty pool")
          } else if (conv.routedModelID !== undefined && !conv.needsReEval) {
            decided = conv.routedModelID
          } else if (bearer) {
            const decision = await getRouterDecision(capiBase(auto.baseURL), bearer, session.sessionToken, prompt, session.availableModels, {
              session_id: event.sessionID,
              turn_number: conv.turn + 1,
              previous_model: conv.previousModel,
              reference_count: conv.referenceCount,
              prompt_char_count: prompt.length,
            })
            const candidates = (decision?.candidate_models ?? [])
              .map((pid) => knownModelsById.get(pid)?.id ?? knownModelsByModelID.get(pid)?.id ?? pid)
              .filter((oid) => matchesFamily(oid, auto.familyFilter))
            if (candidates.length) {
              const label = decision?.predicted_label
              const labelPrefs = label === "needs_reasoning" ? auto.reasoningIds : label === "no_reasoning" ? auto.noReasoningIds : auto.preferredIds
              const eff = labelPrefs.length ? labelPrefs : auto.preferredIds
              const sameFam = (() => {
                const sf = candidates.filter((c) => isSameFamilyId(c, auto.anchorId))
                if (!sf.length) return undefined
                for (const p of eff) if (sf.includes(p)) return p
                return sf[0]
              })()
              if (sameFam) {
                decided = sameFam
                log(`intent routed -> ${decided} (top=${candidates[0]}, label=${label})`)
              } else {
                log(`intent top=${candidates[0]} not same-family as ${auto.anchorId}; keep ${decided}`)
              }
            }
            conv.routedModelID = decided
            conv.routedLabel = decision?.predicted_label
            conv.needsReEval = false
          }
        }

        conv.turn += 1
        if (decided && decided !== event.model.id) {
          const before = event.model.id
          try {
            event.model.id = decided
          } catch {
            event.model = { providerID: PROVIDER_ID, id: decided }
          }
          conv.previousModel = decided
          log(`context override ${before} -> ${decided} (session ${event.sessionID} turn ${conv.turn})`)
          // Reasoning boost for needs_reasoning (mirrors V1 reasoningOptions).
          if (conv.routedLabel === "needs_reasoning") {
            const fam = familyLabel(modelById(decided))
            if (fam === "Claude") {
              event.options.thinking = { type: "enabled", budgetTokens: 16000 }
            } else {
              event.options.reasoningEffort = "high"
              event.options.reasoningSummary = "auto"
            }
          }
        }
      },
      { providerID: PROVIDER_ID },
    )

    // Auxiliary requests (title/generate/compaction) still use the auto id.
    // When the Luna anchor is missing from the auto pool, they must NOT send
    // the session token (else "Requested model not available for session").
    for (const kind of ["title", "generate", "compaction"]) {
      await ctx.session.hook(
        kind,
        async (event) => {
          if (event.model?.providerID !== PROVIDER_ID) return
          const auto = injectedAutoByID.get(event.model.id)
          if (!auto) return
          const conv = getConv(event.sessionID, auto.id)
          const session = await ensureSession(event.sessionID, auto)
          if (!session) {
            conv.omitSessionToken = true
            return
          }
          const anchorModelID = knownModelsById.get(auto.anchorId)?.modelID ?? auto.anchorId
          const anchorInPool = session.availableModels.includes(auto.anchorId) || session.availableModels.includes(anchorModelID)
          if (!anchorInPool && session.availableModels.length) {
            conv.omitSessionToken = true
            log(`${kind} best-effort ${auto.id} anchor ${auto.anchorId} without token`)
          }
        },
        { providerID: PROVIDER_ID },
      )
    }

    // HTTP hook: Copilot chat requires first-party client headers.
    // Direct chat without these 400s with "not available for integrator opencode".
    // VS Code always sends Editor-Version / Editor-Plugin-Version / Copilot-Integration-Id.
    // Use licensed VS Code value (vscode-chat) so Luna + pool models are entitled.
    // Luna (temperature=false in catalog) 400s with "not supported" when temperature
    // is sent, so strip it for Luna-anchored/routed requests.
    await ctx.session.hook(
      "http.request",
      async (event) => {
        if (event.model?.providerID !== PROVIDER_ID) return
        try {
          event.request.headers.set("Copilot-Integration-Id", "vscode-chat")
          if (!event.request.headers.has("Editor-Version")) event.request.headers.set("Editor-Version", "vscode/1.99.0")
          if (!event.request.headers.has("Editor-Plugin-Version")) event.request.headers.set("Editor-Plugin-Version", "copilot-chat/0.40.0")
        } catch (e) {
          log(`http.request header set failed: ${String(e).slice(0, 200)}`)
        }
        // Strip temperature for Luna (catalog temperature=false; codex/others support it).
        try {
          const mid = String(event.model?.id ?? "").toLowerCase()
          let isLuna = mid.includes("luna")
          if (!isLuna) {
            const autos = conversations.get(event.sessionID)
            if (autos) {
              for (const [aid, conv] of autos.entries()) {
                const a = injectedAutoByID.get(aid)
                if (!a) continue
                if (conv.routedModelID === event.model.id || event.model.id === aid) {
                  const anchor = String(a.anchorId ?? "").toLowerCase()
                  const routed = String(conv.routedModelID ?? "").toLowerCase()
                  if (anchor.includes("luna") || routed.includes("luna")) {
                    isLuna = true
                    break
                  }
                }
              }
            }
          }
          if (!isLuna) return
          if (event.request.method === "GET" || event.request.method === "HEAD") return
          const raw = await event.request.clone().text()
          if (!raw) return
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            return
          }
          let changed = false
          if (body && typeof body === "object") {
            if ("temperature" in body) {
              delete body.temperature
              changed = true
            }
            // Some drivers nest under `input`? Keep it minimal: top-level only.
          }
          if (changed) {
            event.request = new Request(event.request.url, {
              method: event.request.method,
              headers: event.request.headers,
              body: JSON.stringify(body),
            })
            log(`http.request stripped temperature for Luna ${event.model.id}`)
          }
        } catch (e) {
          log(`http.request luna strip failed: ${String(e).slice(0, 200)}`)
        }
      },
      { providerID: PROVIDER_ID },
    )

    // Model-request hook (V1 chat.headers): attach Copilot-Session-Token.
    // Prefers the AutoV2 (/auto) token when the context hook routed via V2;
    // falls back to the legacy session token otherwise.
    await ctx.session.hook(
      "model.request",
      async (event) => {
        if (event.model?.providerID !== PROVIDER_ID) return
        const auto = injectedAutoByID.get(event.model.id)
        // Note: after context override, event.model.id is the routed id,
        // not the auto id — so also handle routed ids by checking conv state.
        const sessionID = event.sessionID
        const autos = conversations.get(sessionID)
        // V2 first: any auto in this session with a fresh V2 token for the
        // current routed model (or the auto id itself for aux requests).
        if (autos) {
          for (const [aid, conv] of autos.entries()) {
            if (!conv.autoV2Token || !conv.autoV2Decision) continue
            if (Date.now() > conv.autoV2Decision.expiresAtMs - SESSION_REFRESH_SKEW_MS) continue
            if (event.model.id === aid || conv.routedModelID === event.model.id) {
              event.headers["Copilot-Session-Token"] = conv.autoV2Token
              log(`model.request v2 token for ${event.model.id} (via ${aid})`)
              return
            }
          }
        }
        let token
        let autoID = auto?.id
        if (auto) {
          const conv = getConv(sessionID, auto.id)
          if (conv.omitSessionToken) return
          const session = await ensureSession(sessionID, auto)
          token = session?.sessionToken
        } else if (autos) {
          // Routed model id: find the auto that routed to it in this session.
          for (const [aid, conv] of autos.entries()) {
            if (conv.routedModelID === event.model.id && !conv.omitSessionToken) {
              const a = injectedAutoByID.get(aid)
              if (!a) continue
              const session = await ensureSession(sessionID, a)
              token = session?.sessionToken
              autoID = aid
              break
            }
          }
          // Fallback: attach current session token of any auto in this session
          // (keeps Luna routed requests in the auto billing pool).
          if (!token) {
            for (const [aid, conv] of autos.entries()) {
              if (conv.session?.sessionToken && !conv.omitSessionToken) {
                token = conv.session.sessionToken
                autoID = aid
                break
              }
            }
          }
        }
        if (!token) return
        event.headers["Copilot-Session-Token"] = token
        log(`model.request token for ${event.model.id} (via ${autoID ?? "session"})`)
      },
      { providerID: PROVIDER_ID },
    )

    // Compaction invalidation (V1 session.compacted event).
    try {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            if (ev?.type === "session.compacted" && ev?.properties?.sessionID) {
              const m = conversations.get(ev.properties.sessionID)
              if (m?.size) {
                for (const c of m.values()) c.needsReEval = true
                log(`route invalidated by compaction for ${ev.properties.sessionID}`)
              }
            }
          }
        } catch {}
      })()
      log("copilot-auto-luna v2 setup ok; Luna-first AutoGPT active")
      return () => controller.abort()
    } catch {
      log("copilot-auto-luna v2 setup ok (no event sub); Luna-first AutoGPT active")
    }
  },
}
