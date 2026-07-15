import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
} from "../core/canonical-schema.js";
import type { RequestContext } from "../core/request-context.js";
import type { ModelProvider } from "./provider.js";

const estimateTokens = (value: string): number =>
  Math.max(1, Math.ceil(value.length / 4));

export class MockProvider implements ModelProvider {
  readonly id = "mock";

  async complete(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): Promise<CanonicalChatResponse> {
    context.signal.throwIfAborted();

    const lastUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const content = lastUserMessage
      ? `Mock response: ${lastUserMessage.content}`
      : "Mock response: no user message supplied";
    const inputText = request.messages
      .map((message) => `${message.role}:${message.content}`)
      .join("\n");
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(content);

    return {
      id: `mock-${context.requestId}`,
      providerModel: "mock-chat-v1",
      content,
      finishReason: "stop",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: true,
      },
    };
  }

  async *stream(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): AsyncIterable<CanonicalStreamEvent> {
    context.signal.throwIfAborted();
    const response = await this.complete(request, context);
    yield {
      type: "response_start",
      responseId: response.id,
      providerModel: response.providerModel,
    };

    const chunks = response.content.match(/.{1,8}/gu) ?? [];
    for (const content of chunks) {
      context.signal.throwIfAborted();
      yield { type: "content_delta", content };
    }

    yield { type: "usage", usage: response.usage };
    yield { type: "response_end", finishReason: response.finishReason };
  }
}
