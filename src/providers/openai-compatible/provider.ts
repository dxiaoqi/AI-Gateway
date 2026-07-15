import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
  CanonicalUsage,
} from "../../core/canonical-schema.js";
import { GatewayError } from "../../core/errors.js";
import type { RequestContext } from "../../core/request-context.js";
import type { ModelProvider } from "../provider.js";
import { parseSseData } from "./sse.js";

export type FetchClient = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  providerModel: string;
  fetchClient?: FetchClient;
}

interface UnknownRecord {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/u, "");

const mapFinishReason = (value: unknown): "stop" | "length" =>
  value === "length" ? "length" : "stop";

const readUsage = (value: unknown): CanonicalUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: false,
  };
};

const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    throw new GatewayError({
      message: "The model provider returned invalid JSON",
      statusCode: 502,
      code: "provider_invalid_response",
      retryable: false,
      cause: error,
    });
  }
};

const throwForProviderStatus = async (response: Response): Promise<void> => {
  if (response.ok) return;
  try {
    await response.arrayBuffer();
  } catch {
    // Draining an upstream error body is best effort.
  }

  if (response.status === 401 || response.status === 403) {
    throw new GatewayError({
      message: "The model provider rejected gateway credentials",
      statusCode: 502,
      code: "provider_authentication_error",
    });
  }
  if (response.status === 429) {
    throw new GatewayError({
      message: "The model provider rate limit was exceeded",
      statusCode: 429,
      code: "provider_rate_limited",
      retryable: true,
    });
  }
  throw new GatewayError({
    message: `The model provider request failed with HTTP ${response.status}`,
    statusCode: response.status >= 500 ? 502 : 400,
    code: response.status >= 500 ? "provider_unavailable" : "invalid_request_error",
    retryable: response.status >= 500,
  });
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly providerModel: string;
  private readonly fetchClient: FetchClient;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.providerModel = options.providerModel;
    this.fetchClient = options.fetchClient ?? globalThis.fetch;
  }

  async complete(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): Promise<CanonicalChatResponse> {
    const response = await this.fetchResponse(request, context, false);
    await throwForProviderStatus(response);
    const body = await parseJson(response);
    if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
      throw this.invalidResponse();
    }
    const choice = body.choices[0];
    const message = choice.message;
    const usage = readUsage(body.usage);
    if (
      typeof body.id !== "string" ||
      !isRecord(message) ||
      typeof message.content !== "string" ||
      !usage
    ) {
      throw this.invalidResponse();
    }

    return {
      id: body.id,
      providerModel:
        typeof body.model === "string" ? body.model : this.providerModel,
      content: message.content,
      finishReason: mapFinishReason(choice.finish_reason),
      usage,
    };
  }

  async *stream(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): AsyncIterable<CanonicalStreamEvent> {
    const response = await this.fetchResponse(request, context, true);
    await throwForProviderStatus(response);
    if (!response.body) throw this.invalidResponse();

    let responseId: string | undefined;
    let providerModel = this.providerModel;
    let started = false;
    let finishReason: "stop" | "length" | undefined;
    let receivedDone = false;

    for await (const data of parseSseData(response.body, context.signal)) {
      if (data === "[DONE]") {
        receivedDone = true;
        break;
      }
      let body: unknown;
      try {
        body = JSON.parse(data);
      } catch (error) {
        throw new GatewayError({
          message: "The model provider returned an invalid SSE event",
          statusCode: 502,
          code: "provider_invalid_response",
          cause: error,
        });
      }
      if (!isRecord(body)) throw this.invalidResponse();

      if (!started) {
        responseId = typeof body.id === "string" ? body.id : `provider-${context.requestId}`;
        providerModel = typeof body.model === "string" ? body.model : providerModel;
        started = true;
        yield { type: "response_start", responseId, providerModel };
      }

      const usage = readUsage(body.usage);
      if (usage) yield { type: "usage", usage };

      if (Array.isArray(body.choices) && isRecord(body.choices[0])) {
        const choice = body.choices[0];
        if (isRecord(choice.delta) && typeof choice.delta.content === "string") {
          yield { type: "content_delta", content: choice.delta.content };
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    }

    if (!started || (!receivedDone && finishReason === undefined)) {
      throw new GatewayError({
        message: "The model provider ended the response stream unexpectedly",
        statusCode: 502,
        code: "provider_unavailable",
        retryable: true,
      });
    }
    yield { type: "response_end", finishReason: finishReason ?? "stop" };
  }

  private invoke(
    request: CanonicalChatRequest,
    context: RequestContext,
    stream: boolean,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.providerModel,
      messages: request.messages,
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (stream) body.stream_options = { include_usage: true };

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey.length > 0) headers.authorization = `Bearer ${this.apiKey}`;
    if (context.traceparent) headers.traceparent = context.traceparent;

    return this.fetchClient(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: context.signal,
    });
  }

  private async fetchResponse(
    request: CanonicalChatRequest,
    context: RequestContext,
    stream: boolean,
  ): Promise<Response> {
    try {
      return await this.invoke(request, context, stream);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (error instanceof GatewayError) throw error;
      throw new GatewayError({
        message: "The model provider could not be reached",
        statusCode: 502,
        code: "provider_unavailable",
        retryable: true,
        cause: error,
      });
    }
  }

  private invalidResponse(): GatewayError {
    return new GatewayError({
      message: "The model provider returned an incompatible response",
      statusCode: 502,
      code: "provider_invalid_response",
    });
  }
}
