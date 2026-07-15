import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hasValidCsrf } from "@/lib/security";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

const allowedPrefix = "admin/v1/";
const gatewayBaseUrl = () => process.env.GATEWAY_API_BASE_URL ?? "http://127.0.0.1:3000";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const joinedPath = path.join("/");
  const unsafeSegment = path.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")
  );
  if (unsafeSegment || !joinedPath.startsWith(allowedPrefix)) {
    return NextResponse.json({ error: { message: "Unsupported gateway path", code: "proxy_path_denied" } }, { status: 404 });
  }

  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: { message: "Administrator session is required", code: "authentication_error" } }, { status: 401 });
  if (request.method !== "GET" && request.method !== "HEAD" && !hasValidCsrf(request, session)) {
    return NextResponse.json({ error: { message: "CSRF validation failed", code: "csrf_error" } }, { status: 403 });
  }

  const target = new URL("/" + joinedPath, gatewayBaseUrl());
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  const headers = new Headers({ authorization: `Bearer ${session.accessToken}` });
  const ifMatch = request.headers.get("if-match");
  if (ifMatch) headers.set("if-match", ifMatch);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
    const etag = upstream.headers.get("etag");
    if (etag) responseHeaders.set("etag", etag);
    return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: { message: "AI Gateway is unavailable", code: "gateway_unavailable" } }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
