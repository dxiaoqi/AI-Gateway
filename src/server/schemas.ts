import { Type, type Static } from "@sinclair/typebox";

const MessageSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal("system"),
      Type.Literal("user"),
      Type.Literal("assistant"),
      Type.Literal("tool"),
    ]),
    content: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ChatCompletionRequestSchema = Type.Object(
  {
    model: Type.String({ minLength: 1 }),
    messages: Type.Array(MessageSchema, { minItems: 1 }),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    stream: Type.Optional(Type.Boolean()),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.String(), { maxProperties: 32 }),
    ),
  },
  { additionalProperties: false },
);

export type ChatCompletionRequest = Static<
  typeof ChatCompletionRequestSchema
>;
