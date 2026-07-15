import { spawnSync } from "node:child_process";

const commands = [
  ["docker", ["compose", "config", "--quiet"]],
  ["docker", ["compose", "--profile", "tools", "run", "--rm", "promtool", "check", "config", "/etc/prometheus/prometheus.yml"]],
  ["docker", ["compose", "--profile", "tools", "run", "--rm", "promtool", "check", "rules", "/etc/prometheus/rules/recording.yml", "/etc/prometheus/rules/alerts.yml"]],
  ["docker", ["compose", "--profile", "tools", "run", "--rm", "promtool", "test", "rules", "/etc/prometheus/rules.test.yml"]],
  ["docker", ["compose", "--profile", "tools", "run", "--rm", "amtool", "check-config", "/etc/alertmanager/alertmanager.yml"]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(JSON.stringify({ status: "passed", checks: commands.length }, null, 2));
