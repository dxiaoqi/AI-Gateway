import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hasValidOrigin } from "@/lib/security";
import { localAuthRequest } from "@/lib/local-auth";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: { message: "Origin validation failed", code: "csrf_error" } }, { status: 403 });
  const payload = await request.json().catch(() => null);
  if (!payload) return NextResponse.json({ error: { message: "请输入用户名和密码", code: "validation_error" } }, { status: 400 });
  try {
    const upstream = await localAuthRequest("login", payload); const body = await upstream.json() as { accessToken?: string; owner?: unknown; error?: unknown };
    if (!upstream.ok || !body.accessToken) return NextResponse.json({ error: body.error ?? { message: "登录失败", code: "authentication_error" } }, { status: upstream.status });
    const created = await createSession(body.accessToken);
    const response = NextResponse.json({ authenticated: true, csrfToken: created.session.csrfToken, owner: body.owner });
    response.cookies.set(SESSION_COOKIE, created.signedId, sessionCookieOptions(created.ttl)); return response;
  } catch { return NextResponse.json({ error: { message: "AI Gateway is unavailable", code: "gateway_unavailable" } }, { status: 502 }); }
}
