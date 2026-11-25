import { generateText } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildSamChatModel,
  buildResearchModel,
  getSamMaxOutputTokens,
} from "./openrouter";

afterEach(() => vi.unstubAllEnvs());

const completion = () =>
  Response.json({
    choices: [
      {
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
  });

async function requestedBody(trace: () => Promise<Response>) {
  // Each region case needs a fresh copy of the isolate's cached egress country.
  vi.resetModules();
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(trace)
    .mockResolvedValueOnce(completion());
  const router = await import("./openrouter");
  await generateText({
    model: router.buildSamChatModel({ OPENROUTER_API_KEY: "key" }, "max"),
    prompt: "hi",
  });
  return requestBody(fetchMock, 1);
}

it("sends OpenAI calls to MiniMax M3 from a country where OpenAI is blocked", async () => {
  vi.stubEnv("OPENROUTER_SAM_REASONING_EFFORT", "high");
  vi.stubEnv("OPENROUTER_CACHE_CONTROL", "ephemeral-1h");
  expect(
    await requestedBody(async () => new Response("colo=HKG\nloc=HK\n")),
  ).toMatchObject({
    model: "minimax/minimax-m3",
    reasoning: { effort: "medium" },
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
});

it("sends requests to a custom base URL without the region lookup", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(completion());
  await generateText({
    model: buildSamChatModel(stubAccess, "max"),
    prompt: "hi",
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    "https://llm.example.com/v1/chat/completions",
    expect.anything(),
  );
});

it("stays on OpenAI when the country lookup fails", async () => {
  const body = await requestedBody(async () => {
    throw new Error("offline");
  });
  expect(body).toMatchObject({
    model: "openai/gpt-5.6-luna",
    reasoning: { effort: "max" },
  });
  expect(body).not.toHaveProperty("cache_control");
});

const stubAccess = {
  OPENROUTER_API_KEY: "test",
  OPENROUTER_BASE_URL: "https://llm.example.com/v1",
};

function captureCompletion() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(completion());
}

function requestBody(mock: ReturnType<typeof captureCompletion>, index = 0) {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(z.string().parse(mock.mock.calls[index]?.[1]?.body)));
}

it("sends the configured SAM effort and one-hour cache directive", async () => {
  const mock = captureCompletion();
  await generateText({
    model: buildSamChatModel(
      {
        ...stubAccess,
        OPENROUTER_SAM_REASONING_EFFORT: "provider-specific",
        OPENROUTER_CACHE_CONTROL: "ephemeral-1h",
      },
      "max",
    ),
    prompt: "hi",
  });
  expect(requestBody(mock)).toMatchObject({
    reasoning: { effort: "provider-specific" },
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
});

it("caches SAM compaction while keeping its low effort", async () => {
  const mock = captureCompletion();
  await generateText({
    model: buildSamChatModel(
      {
        ...stubAccess,
        OPENROUTER_SAM_REASONING_EFFORT: "high",
        OPENROUTER_CACHE_CONTROL: "ephemeral",
      },
      "low",
    ),
    prompt: "hi",
  });
  const body = requestBody(mock);
  expect(body.reasoning).toEqual({ effort: "low" });
  expect(body.cache_control).toEqual({ type: "ephemeral" });
});

it.each([
  ["", 16_000],
  ["32768", 32768],
  ["none", undefined],
])(
  "applies the SAM token setting %j to the request",
  async (setting, expected) => {
    const mock = captureCompletion();
    await generateText({
      model: buildSamChatModel(stubAccess, "max"),
      maxOutputTokens: getSamMaxOutputTokens({
        OPENROUTER_SAM_MAX_TOKENS: setting,
      }),
      prompt: "hi",
    });
    const body = requestBody(mock);
    if (expected === undefined) expect(body).not.toHaveProperty("max_tokens");
    else expect(body.max_tokens).toBe(expected);
  },
);

it.each(["0", "-1", "1.5", "500oops", "9007199254740992"])(
  "rejects invalid SAM token limit %s",
  (value) => {
    expect(() =>
      getSamMaxOutputTokens({ OPENROUTER_SAM_MAX_TOKENS: value }),
    ).toThrow("OPENROUTER_SAM_MAX_TOKENS");
  },
);

it.each([
  ["", "low"],
  ["provider-specific", "provider-specific"],
])(
  "uses research effort %j independently of SAM",
  async (setting, expected) => {
    vi.stubEnv("OPENROUTER_RESEARCH_REASONING_EFFORT", setting);
    vi.stubEnv("OPENROUTER_SAM_REASONING_EFFORT", "high");
    vi.stubEnv("OPENROUTER_CACHE_CONTROL", "ephemeral");
    const mock = captureCompletion();
    await generateText({
      model: await buildResearchModel({
        apiKey: "test",
        baseURL: stubAccess.OPENROUTER_BASE_URL,
      }),
      prompt: "hi",
    });
    expect(requestBody(mock)).toMatchObject({
      reasoning: { effort: expected },
      cache_control: { type: "ephemeral" },
    });
  },
);
