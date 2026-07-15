import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hasValidCsrf } from "@/lib/security";
import { deleteSession, readSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await readSession(cookie);
  if (!session) return NextResponse.json({ error: { message: "Session expired", code: "authentication_error" } }, { status: 401 });
  if (!hasValidCsrf(request, session)) {
    return NextResponse.json({ error: { message: "CSRF validation failed", code: "csrf_error" } }, { status: 403 });
  }
  await deleteSession(cookie);
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
