import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import plugin from "../src/index"

const makeModel = (id: string, apiId: string, npm: string, url: string, name: string) => ({
  id,
  providerID: "github-copilot",
  api: { id: apiId, url, npm },
  name,
  family: "gpt",
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "2026-01-01",
})

const sonnet = makeModel(
  "claude-sonnet-4.6",
  "claude-sonnet-4-6-20250929",
  "@ai-sdk/anthropic",
  "https://api.githubcopilot.com/v1",
  "Claude Sonnet 4.6",
)
const codex = makeModel(
  "gpt-5.3-codex",
  "gpt-5.3-codex",
  "@ai-sdk/github-copilot",
  "https://api.githubcopilot.com",
  "GPT-5.3 Codex",
)
const haiku = makeModel(
  "claude-haiku-4.5",
  "claude-haiku-4-5-20251001",
  "@ai-sdk/anthropic",
  "https://api.githubcopilot.com/v1",
  "Claude Haiku 4.5",
)
const geminiPro = makeModel(
  "gemini-3.1-pro",
  "gemini-3.1-pro",
  "@ai-sdk/google",
  "https://generativelanguage.googleapis.com/v1beta/openai",
  "Gemini 3.1 Pro",
)
const geminiFlash = makeModel(
  "gemini-3.5-flash",
  "gemini-3.5-flash",
  "@ai-sdk/google",
  "https://generativelanguage.googleapis.com/v1beta/openai",
  "Gemini 3.5 Flash",
)

const oauth = {
  auth: { type: "oauth", refresh: "test-bearer", access: "test-access", expires: Date.now() + 3600_000 } as never,
}

async function callHook(models: Record<string, unknown>, options?: Record<string, unknown>) {
  const hooks = await plugin.server({} as never, options ?? {})
  return hooks.provider!.models!({ id: "github-copilot", models } as never, {})
}

function makeOutput() {
  return {
    temperature: 0,
    topP: 0,
    topK: 0,
    maxOutputTokens: undefined as number | undefined,
    options: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
  }
}

async function callChatParams(models: Record<string, unknown>, options?: Record<string, unknown>, autoID = "auto") {
  const hooks = await plugin.server({} as never, options ?? {})
  const resolved = await hooks.provider!.models!({ id: "github-copilot", models } as never, {})
  const output = makeOutput()
  await hooks["chat.params"]!(
    {
      sessionID: "ses_test",
      agent: "build",
      model: resolved[autoID],
      provider: { source: "config", info: {} as never, options: {} },
      message: {} as never,
    },
    output,
  )
  return output
}

// Simulates a full session+intent routing cycle with mocked fetch, used to test
// per-label preference and label-suffix behavior.
async function callChatParamsWithRouting(
  models: Record<string, unknown>,
  options: Record<string, unknown>,
  sessionID: string,
  intentResponse: {
    predicted_label: "needs_reasoning" | "no_reasoning"
    candidate_models: string[]
    confidence: number
  },
  autoID = "auto",
) {
  const origFetch = globalThis.fetch
  const availableModels = Object.values(models)
    .filter((m) => (m as { providerID: string }).providerID === "github-copilot")
    .map((m) => (m as { api: { id: string } }).api.id)
  const mockSession = {
    session_token: "test-session-token",
    selected_model: availableModels[0],
    available_models: availableModels,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }
  const mockFetch = async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const u = url.toString()
    if (u.includes("/models/session/intent"))
      return new Response(JSON.stringify(intentResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    if (u.includes("/models/session"))
      return new Response(JSON.stringify(mockSession), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    return origFetch(url, _init)
  }
  globalThis.fetch = mockFetch as unknown as typeof fetch
  try {
    const hooks = await plugin.server({} as never, options)
    const resolved = await hooks.provider!.models!({ id: "github-copilot", models } as never, oauth)
    await hooks["chat.message"]!(
      { sessionID } as never,
      { parts: [{ type: "text", text: "test prompt" }] } as never,
    )
    const output = makeOutput()
    await hooks["chat.params"]!(
      {
        sessionID,
        agent: "build",
        model: resolved[autoID],
        provider: { source: "config", info: {} as never, options: {} },
        message: {} as never,
      },
      output,
    )
    return { output, resolved }
  } finally {
    globalThis.fetch = origFetch
  }
}

describe("opencode-github-copilot-auto-model", () => {
  test("uses first available copilot model when no auto session is available", async () => {
    const models = await callHook({ "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex })
    expect(models.auto).toBeDefined()
    expect(models.auto.id).toBe("auto")
    expect(models.auto.api.id).toBe("claude-sonnet-4-6-20250929")
    expect(models.auto.api.npm).toBe("@ai-sdk/anthropic")
    expect(models.auto.name).toBe("Auto")
  })

  test("overrides request body model for auto in chat.params", async () => {
    const output = await callChatParams({ "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex })
    expect(output.options.model).toBe("claude-sonnet-4-6-20250929")
  })

  test("falls back to another available copilot model", async () => {
    const models = await callHook({ "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku })
    expect(models.auto.id).toBe("auto")
    expect(models.auto.api.id).toBe("claude-sonnet-4-6-20250929")
    expect(models.auto.api.npm).toBe("@ai-sdk/anthropic")
    expect(models.auto.name).toBe("Auto")
  })

  test("falls back to claude-haiku-4.5 as last resort", async () => {
    const models = await callHook({ "claude-haiku-4.5": haiku })
    expect(models.auto.id).toBe("auto")
    expect(models.auto.api.id).toBe("claude-haiku-4-5-20251001")
    expect(models.auto.name).toBe("Auto")
  })

  test("preserves /v1 in url for Claude models (Anthropic SDK appends /messages, not /v1/messages)", async () => {
    const models = await callHook({ "claude-sonnet-4.6": sonnet })
    expect(models.auto.api.url).toBe("https://api.githubcopilot.com/v1")
  })

  test("no-ops when auto already present", async () => {
    const existing = makeModel("auto", "auto", "@ai-sdk/github-copilot", "https://api.githubcopilot.com", "Auto")
    const models = await callHook({ auto: existing, "gpt-5.3-codex": codex })
    expect(models.auto.api.id).toBe("auto")
  })

  test("injects auto from any available copilot model", async () => {
    const other = makeModel("gpt-5.5", "gpt-5.5", "@ai-sdk/github-copilot", "https://api.githubcopilot.com", "GPT-5.5")
    const models = await callHook({ "gpt-5.5": other })
    expect(models.auto).toBeDefined()
    expect(models.auto.api.id).toBe("gpt-5.5")
  })

  test("supports preferredModels by model key", async () => {
    const models = await callHook(
      { "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex },
      { preferredModels: ["gpt-5.3-codex"] },
    )
    expect(models.auto.api.id).toBe("gpt-5.3-codex")
  })

  test("supports preferredModels ordered list", async () => {
    const models = await callHook(
      { "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex },
      { preferredModels: ["missing", "gpt-5.3-codex", "claude-sonnet-4.6"] },
    )
    expect(models.auto.api.id).toBe("gpt-5.3-codex")
  })

  test("chat.params uses preferred fallback model when sessions are unavailable", async () => {
    const output = await callChatParams(
      { "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex },
      { preferredModels: ["gpt-5.3-codex"] },
    )
    expect(output.options.model).toBe("gpt-5.3-codex")
  })

  test("injects configured autos with derived ids and names", async () => {
    const models = await callHook(
      { "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku, "gpt-5.3-codex": codex },
      {
        autos: [
          { preferredModels: ["claude-sonnet-4.6", "claude-haiku-4.5"] },
          { name: "Auto GPT/Codex", preferredModels: ["gpt-5.3-codex"] },
        ],
      },
    )
    expect(models.auto.name).toBe("Auto")
    expect(models["auto-claude"].name).toBe("Auto Claude")
    expect(models["auto-gpt-codex"].name).toBe("Auto GPT/Codex")
  })

  test("derives gemini auto family from configured preferred models", async () => {
    const models = await callHook(
      { "gemini-3.1-pro": geminiPro, "gemini-3.5-flash": geminiFlash },
      { autos: [{ preferredModels: ["gemini-3.1-pro", "gemini-3.5-flash"] }] },
    )
    expect(models["auto-gemini"].name).toBe("Auto Gemini")
    expect(models["auto-gemini"].api.npm).toBe("@ai-sdk/google")
  })

  test("configured gemini auto keeps its preferred family when session pool omits gemini", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const u = url.toString()
      if (u.includes("/models/session"))
        return new Response(
          JSON.stringify({
            session_token: "test-session-token",
            selected_model: "claude-sonnet-4-6-20250929",
            available_models: ["claude-sonnet-4-6-20250929", "gpt-5.3-codex"],
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      return origFetch(url, _init)
    }) as unknown as typeof fetch

    try {
      const hooks = await plugin.server({} as never, {
        autos: [{ name: "Auto Gemini", preferredModels: ["gemini-3.1-pro", "gemini-3.5-flash"] }],
      })
      const models = await hooks.provider!.models!(
        {
          id: "github-copilot",
          models: {
            "claude-sonnet-4.6": sonnet,
            "gpt-5.3-codex": codex,
            "gemini-3.1-pro": geminiPro,
            "gemini-3.5-flash": geminiFlash,
          },
        } as never,
        oauth,
      )

      expect(models["auto-gemini"].api.id).toBe("gemini-3.1-pro")
      expect(models["auto-gemini"].api.npm).toBe("@ai-sdk/google")
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("configured gemini auto omits session token when session pool omits gemini", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const u = url.toString()
      if (u.includes("/models/session/intent"))
        return new Response(
          JSON.stringify({
            predicted_label: "no_reasoning",
            candidate_models: ["gpt-5.3-codex", "claude-sonnet-4-6-20250929"],
            confidence: 0.93,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      if (u.includes("/models/session"))
        return new Response(
          JSON.stringify({
            session_token: "test-session-token",
            selected_model: "claude-sonnet-4-6-20250929",
            available_models: ["claude-sonnet-4-6-20250929", "gpt-5.3-codex"],
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      return origFetch(url, _init)
    }) as unknown as typeof fetch

    try {
      const toasts: { body: { message: string; variant: string } }[] = []
      const hooks = await plugin.server(
        {
          client: { tui: { showToast: async (toast: { body: { message: string; variant: string } }) => toasts.push(toast) } },
        } as never,
        {
          autos: [
            {
              name: "Auto Gemini",
              preferredModels: ["gemini-3.1-pro", "gemini-3.5-flash"],
              reasoning: ["gemini-3.1-pro"],
              noReasoning: ["gemini-3.5-flash"],
            },
          ],
        },
      )
      const models = await hooks.provider!.models!(
        {
          id: "github-copilot",
          models: {
            "claude-sonnet-4.6": sonnet,
            "gpt-5.3-codex": codex,
            "gemini-3.1-pro": geminiPro,
            "gemini-3.5-flash": geminiFlash,
          },
        } as never,
        oauth,
      )
      await hooks["chat.message"]!(
        { sessionID: "ses_gemini_missing_pool" } as never,
        { parts: [{ type: "text", text: "test prompt" }] } as never,
      )
      const paramsOutput = makeOutput()
      await hooks["chat.params"]!(
        {
          sessionID: "ses_gemini_missing_pool",
          agent: "build",
          model: models["auto-gemini"],
          provider: { source: "config", info: {} as never, options: {} },
          message: {} as never,
        },
        paramsOutput,
      )
      const headersOutput = makeOutput()
      await hooks["chat.headers"]!(
        {
          sessionID: "ses_gemini_missing_pool",
          agent: "build",
          model: models["auto-gemini"],
          provider: { source: "config", info: {} as never, options: {} },
          message: {} as never,
        },
        headersOutput,
      )

      expect(paramsOutput.options.model).toBe("gemini-3.5-flash")
      expect(headersOutput.headers["Copilot-Session-Token"]).toBeUndefined()
      expect(toasts).toEqual([
        { body: { message: "Auto Gemini → gemini-3.5-flash · no_reasoning", variant: "info" } },
      ])
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("noReasoning option picks preferred fast model when intent says no_reasoning", async () => {
    const { output } = await callChatParamsWithRouting(
      { "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku },
      { noReasoning: ["claude-haiku-4.5"] },
      "ses_no_reasoning_1",
      {
        predicted_label: "no_reasoning",
        candidate_models: ["claude-sonnet-4-6-20250929", "claude-haiku-4-5-20251001"],
        confidence: 0.95,
      },
    )
    expect(output.options.model).toBe("claude-haiku-4-5-20251001")
  })

  test("reasoning option picks preferred strong model when intent says needs_reasoning", async () => {
    const { output } = await callChatParamsWithRouting(
      { "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku },
      { reasoning: ["claude-sonnet-4.6"], noReasoning: ["claude-haiku-4.5"] },
      "ses_reasoning_1",
      {
        predicted_label: "needs_reasoning",
        candidate_models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6-20250929"],
        confidence: 0.91,
      },
    )
    expect(output.options.model).toBe("claude-sonnet-4-6-20250929")
  })

  test("configured claude auto skips cross-family candidates", async () => {
    const { output } = await callChatParamsWithRouting(
      { "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku, "gpt-5.3-codex": codex },
      {
        autos: [
          {
            preferredModels: ["claude-sonnet-4.6", "claude-haiku-4.5"],
            noReasoning: ["claude-haiku-4.5"],
          },
        ],
      },
      "ses_auto_claude_1",
      {
        predicted_label: "no_reasoning",
        candidate_models: ["gpt-5.3-codex", "claude-sonnet-4-6-20250929", "claude-haiku-4-5-20251001"],
        confidence: 0.87,
      },
      "auto-claude",
    )
    expect(output.options.model).toBe("claude-haiku-4-5-20251001")
  })

  test("configured gpt auto stays in gpt family", async () => {
    const { output } = await callChatParamsWithRouting(
      { "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex },
      { autos: [{ name: "Auto GPT/Codex", preferredModels: ["gpt-5.3-codex"] }] },
      "ses_auto_gpt_1",
      {
        predicted_label: "no_reasoning",
        candidate_models: ["claude-sonnet-4-6-20250929", "gpt-5.3-codex"],
        confidence: 0.89,
      },
      "auto-gpt-codex",
    )
    expect(output.options.model).toBe("gpt-5.3-codex")
  })

  test("keeps routing cache separate per auto within one session", async () => {
    const origFetch = globalThis.fetch
    const models = { "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku, "gpt-5.3-codex": codex }
    const availableModels = Object.values(models)
      .filter((m) => (m as { providerID: string }).providerID === "github-copilot")
      .map((m) => (m as { api: { id: string } }).api.id)
    const mockSession = {
      session_token: "test-session-token",
      selected_model: availableModels[0],
      available_models: availableModels,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }
    const intents = [
      {
        predicted_label: "no_reasoning",
        candidate_models: ["gpt-5.3-codex", "claude-sonnet-4-6-20250929", "claude-haiku-4-5-20251001"],
        confidence: 0.94,
      },
      {
        predicted_label: "no_reasoning",
        candidate_models: ["claude-sonnet-4-6-20250929", "gpt-5.3-codex"],
        confidence: 0.88,
      },
    ]
    let intentCalls = 0
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const u = url.toString()
      if (u.includes("/models/session/intent")) {
        const payload = intents[intentCalls]
        intentCalls += 1
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (u.includes("/models/session"))
        return new Response(JSON.stringify(mockSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      return origFetch(url, _init)
    }) as unknown as typeof fetch

    try {
      const hooks = await plugin.server(
        {
          client: { tui: { showToast: async () => undefined } },
        } as never,
        {
          autos: [
            {
              preferredModels: ["claude-sonnet-4.6", "claude-haiku-4.5"],
              noReasoning: ["claude-haiku-4.5"],
            },
            { name: "Auto GPT/Codex", preferredModels: ["gpt-5.3-codex"] },
          ],
        },
      )
      const resolved = await hooks.provider!.models!({ id: "github-copilot", models } as never, oauth)
      await hooks["chat.message"]!(
        { sessionID: "ses_shared" } as never,
        { parts: [{ type: "text", text: "test prompt" }] } as never,
      )

      const claudeOutput = makeOutput()
      await hooks["chat.params"]!(
        {
          sessionID: "ses_shared",
          agent: "build",
          model: resolved["auto-claude"],
          provider: { source: "config", info: {} as never, options: {} },
          message: {} as never,
        },
        claudeOutput,
      )

      const gptOutput = makeOutput()
      await hooks["chat.params"]!(
        {
          sessionID: "ses_shared",
          agent: "build",
          model: resolved["auto-gpt-codex"],
          provider: { source: "config", info: {} as never, options: {} },
          message: {} as never,
        },
        gptOutput,
      )

      expect(claudeOutput.options.model).toBe("claude-haiku-4-5-20251001")
      expect(gptOutput.options.model).toBe("gpt-5.3-codex")
      expect(intentCalls).toBe(2)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("keeps the missing-pool fallback route sticky across turns", async () => {
    const origFetch = globalThis.fetch
    // Session pool omits gemini, so the auto-gemini route takes the missing-pool
    // fallback path. Each turn's router verdict differs; a sticky route must keep the
    // first turn's model (KV cache stability) and not re-query the router.
    const intents = [
      { predicted_label: "no_reasoning", candidate_models: ["gpt-5.3-codex"], confidence: 0.9 },
      { predicted_label: "needs_reasoning", candidate_models: ["gpt-5.3-codex"], confidence: 0.9 },
    ]
    let intentCalls = 0
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const u = url.toString()
      if (u.includes("/models/session/intent")) {
        const payload = intents[Math.min(intentCalls, intents.length - 1)]
        intentCalls += 1
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (u.includes("/models/session"))
        return new Response(
          JSON.stringify({
            session_token: "test-session-token",
            selected_model: "claude-sonnet-4-6-20250929",
            available_models: ["claude-sonnet-4-6-20250929", "gpt-5.3-codex"],
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      return origFetch(url, _init)
    }) as unknown as typeof fetch

    try {
      const hooks = await plugin.server(
        { client: { tui: { showToast: async () => undefined } } } as never,
        {
          autos: [
            {
              name: "Auto Gemini",
              preferredModels: ["gemini-3.1-pro", "gemini-3.5-flash"],
              reasoning: ["gemini-3.1-pro"],
              noReasoning: ["gemini-3.5-flash"],
            },
          ],
        },
      )
      const resolved = await hooks.provider!.models!(
        {
          id: "github-copilot",
          models: {
            "claude-sonnet-4.6": sonnet,
            "gpt-5.3-codex": codex,
            "gemini-3.1-pro": geminiPro,
            "gemini-3.5-flash": geminiFlash,
          },
        } as never,
        oauth,
      )

      const runTurn = async () => {
        await hooks["chat.message"]!(
          { sessionID: "ses_gemini_sticky" } as never,
          { parts: [{ type: "text", text: "test prompt" }] } as never,
        )
        const context = {
          sessionID: "ses_gemini_sticky",
          agent: "build",
          model: resolved["auto-gemini"],
          provider: { source: "config" as const, info: {} as never, options: {} },
          message: {} as never,
        }
        const paramsOutput = makeOutput()
        await hooks["chat.params"]!(context, paramsOutput)
        const headersOutput = makeOutput()
        await hooks["chat.headers"]!(context, headersOutput)
        return { paramsOutput, headersOutput }
      }

      const turn0 = await runTurn()
      const turn1 = await runTurn()

      expect(turn0.paramsOutput.options.model).toBe("gemini-3.5-flash")
      // Sticky: turn 1 must reuse turn 0's model despite the flipped verdict.
      expect(turn1.paramsOutput.options.model).toBe("gemini-3.5-flash")
      // The session token stays omitted on the sticky turn too.
      expect(turn0.headersOutput.headers["Copilot-Session-Token"]).toBeUndefined()
      expect(turn1.headersOutput.headers["Copilot-Session-Token"]).toBeUndefined()
      expect(intentCalls).toBe(1)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("dedupes derived ids and names for same-family autos", async () => {
    const models = await callHook(
      { "claude-sonnet-4.6": sonnet, "claude-haiku-4.5": haiku },
      {
        autos: [
          { preferredModels: ["claude-sonnet-4.6"] },
          { preferredModels: ["claude-haiku-4.5"] },
        ],
      },
    )
    // Both anchor on the Claude family, so ids/names must be disambiguated.
    expect(models["auto-claude"]).toBeDefined()
    expect(models["auto-claude-2"]).toBeDefined()
    expect(models["auto-claude"].name).toBe("Auto Claude")
    expect(models["auto-claude-2"].name).toBe("Auto Claude 2")
    // Legacy auto is untouched.
    expect(models.auto.id).toBe("auto")
    expect(models.auto.name).toBe("Auto")
  })

  test("derives a unique id when a configured name collides with the legacy auto", async () => {
    const models = await callHook(
      { "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex },
      { autos: [{ name: "Auto" }] },
    )
    expect(models.auto.name).toBe("Auto")
    expect(models["auto-2"]).toBeDefined()
    expect(models["auto-2"].name).toBe("Auto 2")
  })
})

// Packaging guards for the supported (local-path) install. opencode loads the
// plugin from the file referenced in config: dist/index.js (after `bun run build`)
// or src/index.ts dropped into ~/.config/opencode/plugins/. Either way opencode's
// loader requires a default export of `{ id, server: <function> }`. (The `github:`
// install path is intentionally unsupported: opencode git-clones the repo on every
// launch and disposes short-lived commands before the clone finishes, so arborist
// rolls the partial install back — a local path resolves with a cheap stat instead.)
describe("packaging", () => {
  const root = path.join(import.meta.dir, "..")
  const entry = (pkg as { exports?: { ["."]?: { import?: string } }; main?: string }).exports?.["."]?.import ?? pkg.main
  const rel = (entry ?? "").replace(/^\.\//, "")

  test("declares a package entry", () => {
    expect(rel.length).toBeGreaterThan(0)
  })

  test("entry file exists on disk", () => {
    expect(existsSync(path.join(root, rel))).toBe(true)
  })

  test("default export has the shape opencode loads (id + server function)", () => {
    expect(typeof plugin).toBe("object")
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id.length).toBeGreaterThan(0)
    expect(typeof plugin.server).toBe("function")
  })
})
