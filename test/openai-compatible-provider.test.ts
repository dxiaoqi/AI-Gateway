import { describe, expect, it, vi } from "vitest";
import type { CanonicalStreamEvent } from "../src/core/canonical-schema.js";
import { GatewayError } from "../src/core/errors.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/provider.js";
import type { FetchClient } from "../src/providers/openai-compatible/provider.js";

const encoder = new TextEncoder();
const context = () => ({
  requestId: "request-1",
  startedAt: performance.now(),
  signal: new AbortController().signal,
});
const request = {
  logicalModel: "external",
  messages: [{ role: "user" as const, content: "Hello" }],
};

const sseResponse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("OpenAICompatibleProvider", () => {
  it("maps a non-streaming completion to the canonical response", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchClient = vi.fn<FetchClient>(async (_input, init) => {
      capturedInit = init;
      return (
      new Response(
        JSON.stringify({
          id: "chat-1",
          model: "provider-model-v2",
          choices: [
            { message: { role: "assistant", content: "World" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
      );
    });
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://provider.test/v1/",
      apiKey: "secret",
      providerModel: "provider-model",
      fetchClient,
    });

    const response = await provider.complete(request, context());
    expect(response.content).toBe("World");
    expect(response.providerModel).toBe("provider-model-v2");
    expect(response.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      estimated: false,
    });
    expect(fetchClient).toHaveBeenCalledWith(
      "https://provider.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      model: "provider-model",
      stream: false,
    });
  });

  it("maps chunked provider SSE to canonical stream events", async () => {
    const fetchClient = vi.fn(async () =>
      sseResponse([
        'data: {"id":"chat-2","model":"provider-model","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chat-2","choices":[{"delta":{"content":"Hel',
        'lo"},"finish_reason":null}]}\n\n',
        'data: {"id":"chat-2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chat-2","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
      providerModel: "provider-model",
      fetchClient,
    });

    const events: CanonicalStreamEvent[] = [];
    for await (const event of provider.stream(request, context())) events.push(event);
    expect(events).toEqual([
      { type: "response_start", responseId: "chat-2", providerModel: "provider-model" },
      { type: "content_delta", content: "Hello" },
      {
        type: "usage",
        usage: {
          inputTokens: 3,
          outputTokens: 1,
          totalTokens: 4,
          estimated: false,
        },
      },
      { type: "response_end", finishReason: "stop" },
    ]);
  });

  it("normalizes provider rate limits", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
      providerModel: "provider-model",
      fetchClient: async () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
        }),
    });

    await expect(provider.complete(request, context())).rejects.toMatchObject({
      statusCode: 429,
      code: "provider_rate_limited",
      retryable: true,
    } satisfies Partial<GatewayError>);
  });

  it("forwards the gateway traceparent to the provider", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
      providerModel: "provider-model",
      fetchClient: async (_input, init) => {
        capturedHeaders = init?.headers;
        return new Response(JSON.stringify({
          id: "chat-traced",
          model: "provider-model",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200 });
      },
    });
    const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    await provider.complete(request, { ...context(), traceparent });
    expect(capturedHeaders).toMatchObject({ traceparent });
  });

  it("normalizes network failures as retryable provider errors", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
      providerModel: "provider-model",
      fetchClient: async () => {
        throw new TypeError("connection reset");
      },
    });

    await expect(provider.complete(request, context())).rejects.toMatchObject({
      statusCode: 502,
      code: "provider_unavailable",
      retryable: true,
    } satisfies Partial<GatewayError>);
  });
});
