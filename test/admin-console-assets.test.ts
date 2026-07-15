import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("Next.js administrator console", () => {
  it("keeps administrator tokens in React memory and uses a same-origin BFF", async () => {
    const consoleSource = await read("apps/admin-console/components/admin-console.tsx");
    expect(consoleSource).toContain("useState(\"\")");
    expect(consoleSource).toContain("/api/gateway/admin/v1/");
    expect(consoleSource).not.toContain("localStorage");
    expect(consoleSource).not.toContain("sessionStorage");
    expect(consoleSource).not.toContain("NEXT_PUBLIC_");
  });

  it("restricts the server-side proxy to administrator API paths", async () => {
    const proxy = await read("apps/admin-console/app/api/gateway/[...path]/route.ts");
    expect(proxy).toContain('const allowedPrefix = "admin/v1/"');
    expect(proxy).toContain('redirect: "manual"');
    expect(proxy).toContain("unsafeSegment");
    expect(proxy).not.toContain("console.log");
  });

  it("documents a server-only Gateway base URL", async () => {
    const env = await read("apps/admin-console/.env.example");
    expect(env).toContain("GATEWAY_API_BASE_URL=");
    expect(env).not.toContain("NEXT_PUBLIC_");
  });
});
