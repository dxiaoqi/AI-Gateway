import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hasValidOrigin } from "@/lib/security";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production" || process.env.ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN !== "true") {
    return NextResponse.json({ error: { message: "Development login is disabled", code: "not_found" } }, { status: 404 });
  }
  if (!hasValidOrigin(request)) {
    return NextResponse.json({ error: { message: "Origin validation failed", code: "csrf_error" } }, { status: 403 });
  }
  const payload = await request.json().catch(() => null) as { token?: unknown } | null;
  if (!payload || typeof payload.token !== "string" || payload.token.length < 8 || payload.token.length > 16_384) {
    return NextResponse.json({ error: { message: "A valid development token is required", code: "validation_error" } }, { status: 400 });
  }
  const gateway = process.env.GATEWAY_API_BASE_URL ?? "http://127.0.0.1:3000";
  try {
    const validation = await fetch(new URL("/admin/v1/me", gateway), {
      headers: { authorization: `Bearer ${payload.token}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!validation.ok) {
      return NextResponse.json({ error: { message: "Token validation failed", code: "authentication_error" } }, { status: 401 });
    }
    const created = await createSession(payload.token);
    const response = NextResponse.json({ authenticated: true, csrfToken: created.session.csrfToken });
    response.cookies.set(SESSION_COOKIE, created.signedId, sessionCookieOptions(created.ttl));
    return response;
  } catch {
    return NextResponse.json({ error: { message: "AI Gateway is unavailable", code: "gateway_unavailable" } }, { status: 502 });
  }
}
