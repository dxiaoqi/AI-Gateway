import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
} from "../core/canonical-schema.js";
import type { RequestContext } from "../core/request-context.js";

export interface ModelProvider {
  readonly id: string;
  complete(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): Promise<CanonicalChatResponse>;
  stream(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): AsyncIterable<CanonicalStreamEvent>;
}
