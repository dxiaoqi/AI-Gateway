import { describe, expect, it } from "vitest";
import { parseSseData } from "../src/providers/openai-compatible/sse.js";

const streamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

describe("parseSseData", () => {
  it("parses events split across arbitrary chunks and line endings", async () => {
    const body = streamFromChunks([
      'data: {"a":',
      "1}\r\n\r",
      "\ndata: second\n\n",
      "data: [DONE]\n\n",
    ]);
    const values: string[] = [];
    for await (const value of parseSseData(body, new AbortController().signal)) {
      values.push(value);
    }
    expect(values).toEqual(['{"a":1}', "second", "[DONE]"]);
  });

  it("joins multiline SSE data fields", async () => {
    const body = streamFromChunks(["data: first\ndata: second\n\n"]);
    const values: string[] = [];
    for await (const value of parseSseData(body, new AbortController().signal)) {
      values.push(value);
    }
    expect(values).toEqual(["first\nsecond"]);
  });
});
