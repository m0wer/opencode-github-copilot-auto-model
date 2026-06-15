import { execFileSync } from "node:child_process"
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
    const resolved =     await hooks.provider!.models!({ id: "github-copilot", models } as never, {
      auth: { type: "oauth", refresh: "test-bearer", access: "test-access", expires: Date.now() + 3600_000 } as never,
    })
    await hooks["chat.message"]!(
      { sessionID } as never,
      { parts: [{ type: "text", text: "test prompt" }] } as never,
    )
    const output = {
      temperature: 0,
      topP: 0,
      topK: 0,
      maxOutputTokens: undefined as number | undefined,
      options: {} as Record<string, unknown>,
      headers: {} as Record<string, string>,
    }
    await hooks["chat.params"]!(
      {
        sessionID,
        agent: "build",
        model: resolved.auto,
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
})

// Regression guard for the GitHub install path: opencode (Bun) loads the plugin via
// the package entry. `dist/` is gitignored, so a `github:` install only ships the
// files committed to git. The entry must therefore resolve to a committed source
// file, otherwise the plugin registers but never runs (the bug this guards against).
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

  test("entry is tracked by git so a github install can resolve it", () => {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", rel], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      // No git binary (e.g. running from an extracted tarball): the existence check
      // above is sufficient. Only fail when git is present and the file is untracked.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new Error(`package entry "${rel}" is not tracked by git; a github: install would fail to load it`)
    }
  })
})
