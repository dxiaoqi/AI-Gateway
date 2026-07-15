import { describe, expect, it } from "vitest";
import { resolveRequestOrigin } from "../apps/admin-console/lib/origin.js";

function request(host: string, nextOrigin = "http://localhost:3100", forwarded: Record<string, string> = {}) {
  return {
    headers: new Headers({ host, ...forwarded }),
    nextUrl: new URL(nextOrigin),
  };
}

describe("administrator console origin validation", () => {
  it("uses the actual Host header in local development when Next.js normalizes nextUrl to localhost", () => {
    expect(resolveRequestOrigin(request("127.0.0.1:3100"))).toBe("http://127.0.0.1:3100");
  });

  it("still rejects a different browser origin", () => {
    expect(resolveRequestOrigin(request("127.0.0.1:3100"))).not.toBe("http://evil.example");
  });

  it("uses the explicitly configured public origin as the production authority", () => {
    expect(resolveRequestOrigin(request("internal-next:3100"), "https://ai-admin.example.com/"))
      .toBe("https://ai-admin.example.com");
  });

  it("understands the public protocol and host supplied by a reverse proxy", () => {
    const proxied = request("internal-next:3100", "http://localhost:3100", {
      "x-forwarded-host": "ai-admin.example.com",
      "x-forwarded-proto": "https",
    });
    expect(resolveRequestOrigin(proxied)).toBe("https://ai-admin.example.com");
  });
});
