import type {
  ProviderAttemptMetadata,
  ProviderAttemptOutcome,
  RoutingEvent,
  RoutingObserver,
} from "./types.js";

type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

interface HistogramSeries {
  labels: Labels;
  count: number;
  sum: number;
  bucketCounts: number[];
}

const durationBuckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const seriesKey = (labels: Labels): string =>
  JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));

const escapeLabel = (value: string): string =>
  value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');

const formatLabels = (labels: Labels, extra?: [string, string]): string => {
  const entries = [...Object.entries(labels), ...(extra ? [extra] : [])];
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
};

export class MetricsRegistry implements RoutingObserver {
  private readonly counters = new Map<string, Map<string, Series>>();
  private readonly gauges = new Map<string, Map<string, Series>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  private increment(name: string, labels: Labels, amount = 1): void {
    const metric = this.counters.get(name) ?? new Map<string, Series>();
    const key = seriesKey(labels);
    const series = metric.get(key) ?? { labels, value: 0 };
    series.value += amount;
    metric.set(key, series);
    this.counters.set(name, metric);
  }

  private addGauge(name: string, labels: Labels, amount: number): void {
    const metric = this.gauges.get(name) ?? new Map<string, Series>();
    const key = seriesKey(labels);
    const series = metric.get(key) ?? { labels, value: 0 };
    series.value += amount;
    metric.set(key, series);
    this.gauges.set(name, metric);
  }

  private observe(name: string, labels: Labels, value: number): void {
    const metric = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    const key = seriesKey(labels);
    const series = metric.get(key) ?? {
      labels,
      count: 0,
      sum: 0,
      bucketCounts: durationBuckets.map(() => 0),
    };
    series.count += 1;
    series.sum += value;
    durationBuckets.forEach((bucket, index) => {
      if (value <= bucket) series.bucketCounts[index] = (series.bucketCounts[index] ?? 0) + 1;
    });
    metric.set(key, series);
    this.histograms.set(name, metric);
  }

  recordHttp(method: string, route: string, statusCode: number, durationMs: number): void {
    const labels = { method, route, status: String(statusCode) };
    this.increment("aigw_http_requests_total", labels);
    this.observe("aigw_http_request_duration_seconds", { method, route }, durationMs / 1_000);
  }

  recordGatewayError(code: string): void {
    this.increment("aigw_errors_total", { code });
  }

  providerStarted(metadata: ProviderAttemptMetadata): void {
    this.addGauge("aigw_provider_requests_active", this.providerLabels(metadata), 1);
  }

  providerFinished(
    metadata: ProviderAttemptMetadata,
    durationMs: number,
    outcome: ProviderAttemptOutcome,
    errorCode = "none",
  ): void {
    const labels = this.providerLabels(metadata);
    this.addGauge("aigw_provider_requests_active", labels, -1);
    this.increment("aigw_provider_requests_total", { ...labels, outcome, error_code: errorCode });
    this.observe("aigw_provider_request_duration_seconds", labels, durationMs / 1_000);
  }

  routingEvent(metadata: ProviderAttemptMetadata, event: RoutingEvent): void {
    this.increment("aigw_routing_events_total", {
      logical_model: metadata.logicalModel,
      deployment: metadata.deploymentId,
      event,
    });
  }

  tokens(
    metadata: ProviderAttemptMetadata,
    inputTokens: number,
    outputTokens: number,
    estimated: boolean,
  ): void {
    const base = {
      logical_model: metadata.logicalModel,
      deployment: metadata.deploymentId,
      estimated: String(estimated),
    };
    this.increment("aigw_tokens_total", { ...base, direction: "input" }, inputTokens);
    this.increment("aigw_tokens_total", { ...base, direction: "output" }, outputTokens);
  }

  render(): string {
    const lines: string[] = [];
    this.renderSimple(lines, "aigw_http_requests_total", "Total completed gateway HTTP requests", "counter");
    this.renderHistogram(lines, "aigw_http_request_duration_seconds", "Gateway HTTP request duration in seconds");
    this.renderSimple(lines, "aigw_errors_total", "Total normalized gateway errors", "counter");
    this.renderSimple(lines, "aigw_provider_requests_active", "Currently active provider requests", "gauge");
    this.renderSimple(lines, "aigw_provider_requests_total", "Total completed provider attempts", "counter");
    this.renderHistogram(lines, "aigw_provider_request_duration_seconds", "Provider attempt duration in seconds");
    this.renderSimple(lines, "aigw_routing_events_total", "Total routing health transition events", "counter");
    this.renderSimple(lines, "aigw_tokens_total", "Total model tokens reported or estimated", "counter");
    return `${lines.join("\n")}\n`;
  }

  private providerLabels(metadata: ProviderAttemptMetadata): Labels {
    return {
      logical_model: metadata.logicalModel,
      deployment: metadata.deploymentId,
      provider: metadata.providerId,
      stream: String(metadata.stream),
    };
  }

  private renderSimple(
    lines: string[],
    name: string,
    help: string,
    type: "counter" | "gauge",
  ): void {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const source = type === "counter" ? this.counters.get(name) : this.gauges.get(name);
    for (const series of source?.values() ?? []) {
      lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
    }
  }

  private renderHistogram(lines: string[], name: string, help: string): void {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
    for (const series of this.histograms.get(name)?.values() ?? []) {
      durationBuckets.forEach((bucket, index) => {
        lines.push(`${name}_bucket${formatLabels(series.labels, ["le", String(bucket)])} ${series.bucketCounts[index] ?? 0}`);
      });
      lines.push(`${name}_bucket${formatLabels(series.labels, ["le", "+Inf"])} ${series.count}`);
      lines.push(`${name}_sum${formatLabels(series.labels)} ${series.sum}`);
      lines.push(`${name}_count${formatLabels(series.labels)} ${series.count}`);
    }
  }
}
