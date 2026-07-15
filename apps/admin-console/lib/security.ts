import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { AdminSession } from "./session";
import { resolveRequestOrigin } from "./origin";

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function expectedOrigin(request: NextRequest) {
  return resolveRequestOrigin(request, process.env.ADMIN_CONSOLE_PUBLIC_ORIGIN);
}

export function hasValidOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  return Boolean(origin && safeEqual(origin, expectedOrigin(request)));
}

export function hasValidCsrf(request: NextRequest, session: AdminSession) {
  const token = request.headers.get("x-csrf-token");
  return hasValidOrigin(request) && Boolean(token && safeEqual(token, session.csrfToken));
}
