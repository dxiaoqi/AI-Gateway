import { config as loadDotEnv } from "dotenv";

loadDotEnv({ quiet: true });

const baseUrl = (
  process.env.GATEWAY_URL ??
  `http://127.0.0.1:${process.env.PORT ?? 3000}`
).replace(/\/$/u, "");
const gatewayKey =
  process.env.SMOKE_GATEWAY_API_KEY ?? process.env.GATEWAY_API_KEY;

if (!gatewayKey) {
  throw new Error(
    "Set SMOKE_GATEWAY_API_KEY or GATEWAY_API_KEY before running the smoke test",
  );
}

const authorization = { authorization: `Bearer ${gatewayKey}` };
const metricsToken =
  process.env.SMOKE_METRICS_BEARER_TOKEN ??
  process.env.METRICS_BEARER_TOKEN ??
  "local-development-metrics-key";

const requestJson = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      `${path} failed with HTTP ${response.status}: ${body?.error?.code ?? "unknown_error"}`,
    );
  }
  return body;
};

const health = await requestJson("/health/ready");
if (health.status !== "ready") {
  throw new Error("Readiness check did not return ready");
}

const modelList = await requestJson("/v1/models", { headers: authorization });
const models = modelList.data?.map((model) => model.id) ?? [];
if (!models.includes("general")) {
  throw new Error("The authenticated caller cannot see the general model");
}

const completion = await requestJson("/v1/chat/completions", {
  method: "POST",
  headers: { ...authorization, "content-type": "application/json" },
  body: JSON.stringify({
    model: "general",
    messages: [{ role: "user", content: "local smoke test" }],
  }),
});
if (
  completion.choices?.[0]?.message?.content !==
  "Mock response: local smoke test"
) {
  throw new Error("The non-streaming mock completion was not normalized correctly");
}

const streamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { ...authorization, "content-type": "application/json" },
  body: JSON.stringify({
    model: "general",
    stream: true,
    messages: [{ role: "user", content: "local stream smoke test" }],
  }),
});
if (!streamResponse.ok) {
  throw new Error(`Streaming request failed with HTTP ${streamResponse.status}`);
}
if (!streamResponse.headers.get("content-type")?.includes("text/event-stream")) {
  throw new Error("Streaming request did not return text/event-stream");
}
const streamText = await streamResponse.text();
const dataEvents = streamText
  .split(/\r?\n\r?\n/u)
  .map((event) =>
    event
      .split(/\r?\n/u)
      .find((line) => line.startsWith("data: "))
      ?.slice(6),
  )
  .filter(Boolean);
if (dataEvents.at(-1) !== "[DONE]") {
  throw new Error("Streaming response did not terminate with [DONE]");
}
const chunks = dataEvents
  .filter((event) => event !== "[DONE]")
  .map((event) => JSON.parse(event));
const responseIds = new Set(chunks.map((chunk) => chunk.id).filter(Boolean));
if (responseIds.size !== 1) {
  throw new Error("Streaming chunks did not preserve one response id");
}
if (!chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop")) {
  throw new Error("Streaming response did not contain a stop event");
}

const metricsResponse = await fetch(`${baseUrl}/metrics`, {
  headers: { authorization: `Bearer ${metricsToken}` },
});
if (!metricsResponse.ok) {
  throw new Error(`/metrics failed with HTTP ${metricsResponse.status}`);
}
const metricsText = await metricsResponse.text();
if (
  !metricsText.includes("aigw_http_requests_total") ||
  !metricsText.includes("aigw_provider_requests_total") ||
  !metricsText.includes("aigw_tokens_total")
) {
  throw new Error("Prometheus output is missing required gateway metrics");
}

let externalResult = "skipped";
if (process.env.SMOKE_EXTERNAL === "true") {
  if (!models.includes("external")) {
    throw new Error("SMOKE_EXTERNAL=true but external is not visible to this key");
  }
  const external = await requestJson("/v1/chat/completions", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({
      model: "external",
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
  });
  externalResult = {
    provider: external.gateway?.provider,
    providerModel: external.gateway?.provider_model,
    usage: external.usage,
  };
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      baseUrl,
      visibleModels: models,
      checks: [
        "readiness",
        "model ACL",
        "non-streaming",
        "SSE termination",
        "SSE response id",
        "protected Prometheus metrics",
      ],
      external: externalResult,
    },
    null,
    2,
  ),
);
