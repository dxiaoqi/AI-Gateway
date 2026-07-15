export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalMessage {
  role: MessageRole;
  content: string;
  name?: string;
}

export interface CanonicalChatRequest {
  logicalModel: string;
  messages: CanonicalMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, string>;
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface CanonicalChatResponse {
  id: string;
  providerModel: string;
  content: string;
  finishReason: "stop" | "length";
  usage: CanonicalUsage;
}

export type CanonicalStreamEvent =
  | {
      type: "response_start";
      responseId: string;
      providerModel: string;
    }
  | {
      type: "content_delta";
      content: string;
    }
  | {
      type: "usage";
      usage: CanonicalUsage;
    }
  | {
      type: "response_end";
      finishReason: "stop" | "length";
    };
