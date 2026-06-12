import { describe, expect, test } from "bun:test"
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

async function callHook(models: Record<string, unknown>, options?: Record<string, unknown>) {
  const hooks = await plugin.server({} as never, options ?? {})
  return hooks.provider!.models!({ id: "github-copilot", models } as never, {})
}

async function callChatParams(models: Record<string, unknown>, options?: Record<string, unknown>) {
  const hooks = await plugin.server({} as never, options ?? {})
  const resolved = await hooks.provider!.models!({ id: "github-copilot", models } as never, {})
  const output = {
    temperature: 0,
    topP: 0,
    topK: 0,
    maxOutputTokens: undefined as number | undefined,
    options: {} as Record<string, unknown>,
  }
  await hooks["chat.params"]!(
    {
      sessionID: "ses_test",
      agent: "build",
      model: resolved.auto,
      provider: { source: "config", info: {} as never, options: {} },
      message: {} as never,
    },
    output,
  )
  return output
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

  test("supports preferredModel by model key", async () => {
    const models = await callHook(
      { "claude-sonnet-4.6": sonnet, "gpt-5.3-codex": codex },
      { preferredModel: "gpt-5.3-codex" },
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
      { preferredModel: "gpt-5.3-codex" },
    )
    expect(output.options.model).toBe("gpt-5.3-codex")
  })
})
