import { GatewayError } from "../../core/errors.js";

const extractData = (rawEvent: string): string | undefined => {
  const dataLines = rawEvent
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return dataLines.length > 0 ? dataLines.join("\n") : undefined;
};

export async function* parseSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let boundary = /\r?\n\r?\n/u.exec(buffer);
      while (boundary) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = extractData(rawEvent);
        if (data !== undefined) yield data;
        boundary = /\r?\n\r?\n/u.exec(buffer);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const data = extractData(buffer);
      if (data !== undefined) yield data;
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new GatewayError({
      message: "The model provider response stream was interrupted",
      statusCode: 502,
      code: "provider_unavailable",
      retryable: true,
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }
}
