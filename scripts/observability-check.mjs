const prometheusUrl = (process.env.PROMETHEUS_URL ?? "http://127.0.0.1:9090").replace(/\/$/u, "");
const alertmanagerUrl = (process.env.ALERTMANAGER_URL ?? "http://127.0.0.1:9093").replace(/\/$/u, "");
const grafanaUrl = (process.env.GRAFANA_URL ?? "http://127.0.0.1:3001").replace(/\/$/u, "");
const grafanaUser = process.env.GRAFANA_ADMIN_USER ?? "admin";
const grafanaPassword = process.env.GRAFANA_ADMIN_PASSWORD ?? "local-admin-change-me";

const requestJson = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
};

const requestOk = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
};

await requestOk(`${prometheusUrl}/-/ready`);
const targets = await requestJson(`${prometheusUrl}/api/v1/targets`);
const gatewayTarget = targets.data?.activeTargets?.find(
  (target) => target.labels?.job === "aigateway",
);
if (!gatewayTarget || gatewayTarget.health !== "up") {
  throw new Error(`AI Gateway Prometheus target is not up: ${gatewayTarget?.lastError ?? "missing"}`);
}

const rules = await requestJson(`${prometheusUrl}/api/v1/rules`);
const groups = rules.data?.groups ?? [];
const recordingRules = groups.flatMap((group) => group.rules ?? []).filter((rule) => rule.type === "recording");
const alertRules = groups.flatMap((group) => group.rules ?? []).filter((rule) => rule.type === "alerting");
if (recordingRules.length < 8 || alertRules.length < 7) {
  throw new Error(`Expected at least 8 recording and 7 alert rules, got ${recordingRules.length}/${alertRules.length}`);
}

const query = await requestJson(
  `${prometheusUrl}/api/v1/query?query=${encodeURIComponent('up{job="aigateway"}')}`,
);
if (query.data?.result?.[0]?.value?.[1] !== "1") {
  throw new Error("Prometheus query did not report the AI Gateway target as up");
}

await requestOk(`${alertmanagerUrl}/-/ready`);
const basic = Buffer.from(`${grafanaUser}:${grafanaPassword}`).toString("base64");
const grafanaHealth = await requestJson(`${grafanaUrl}/api/health`);
if (grafanaHealth.database !== "ok") throw new Error("Grafana database is not healthy");
const dashboard = await requestJson(`${grafanaUrl}/api/dashboards/uid/aigw-overview`, {
  headers: { authorization: `Basic ${basic}` },
});
if (dashboard.dashboard?.title !== "AI Gateway Overview") {
  throw new Error("Provisioned AI Gateway dashboard was not found");
}

console.log(JSON.stringify({
  status: "passed",
  target: gatewayTarget.scrapeUrl,
  recordingRules: recordingRules.length,
  alertRules: alertRules.length,
  dashboard: dashboard.dashboard.title,
}, null, 2));
