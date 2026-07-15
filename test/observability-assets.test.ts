import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("observability as code assets", () => {
  it("pins every observability container image", async () => {
    const compose = await read("compose.yaml");
    expect(compose).toContain("prom/prometheus:v3.12.0");
    expect(compose).toContain("prom/alertmanager:v0.32.1");
    expect(compose).toContain("grafana/grafana:13.1.0");
    expect(compose).not.toMatch(/image:\s+[^\n]*:latest/u);
  });

  it("protects the Prometheus scrape with a credentials file", async () => {
    const config = await read("observability/prometheus/prometheus.yml");
    expect(config).toContain("credentials_file: /run/secrets/aigw_metrics_token");
    expect(config).toContain('targets: ["host.docker.internal:3000"]');
    expect(config).not.toContain("local-development-metrics-key");
  });

  it("keeps SLI and alert rules reviewable and linked to a runbook", async () => {
    const recording = await read("observability/prometheus/rules/recording.yml");
    const alerts = await read("observability/prometheus/rules/alerts.yml");
    expect(recording.match(/- record:/gu)).toHaveLength(9);
    expect(alerts.match(/- alert:/gu)).toHaveLength(7);
    expect(alerts.match(/runbook_url:/gu)).toHaveLength(7);
    expect(`${recording}\n${alerts}`).not.toMatch(/request_id|trace_id|tenant_id|key_id|prompt/iu);
  });

  it("provisions a useful immutable Grafana dashboard", async () => {
    const dashboard = JSON.parse(
      await read("observability/grafana/dashboards/aigateway-overview.json"),
    ) as { uid: string; title: string; editable: boolean; panels: unknown[] };
    expect(dashboard.uid).toBe("aigw-overview");
    expect(dashboard.title).toBe("AI Gateway Overview");
    expect(dashboard.editable).toBe(false);
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(10);
  });
});
