import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { exchangeAuthorizationCode } from "@/lib/oidc";
import {
  consumeOidcTransaction,
  createSession,
  OIDC_TRANSACTION_COOKIE,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";

export const dynamic = "force-dynamic";

function same(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function failed(request: NextRequest, code: string) {
  const origin = process.env.ADMIN_CONSOLE_PUBLIC_ORIGIN ?? request.nextUrl.origin;
  const response = NextResponse.redirect(new URL(`/?auth_error=${code}`, origin));
  response.cookies.delete(OIDC_TRANSACTION_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const transaction = await consumeOidcTransaction(request.cookies.get(OIDC_TRANSACTION_COOKIE)?.value);
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!transaction || !code || !state || !same(state, transaction.state)) return failed(request, "invalid_callback");
  try {
    const tokens = await exchangeAuthorizationCode(code, transaction.codeVerifier, transaction.nonce);
    const created = await createSession(tokens.accessToken, tokens.expiresIn);
    const origin = process.env.ADMIN_CONSOLE_PUBLIC_ORIGIN ?? request.nextUrl.origin;
    const response = NextResponse.redirect(new URL(transaction.returnTo, origin));
    response.cookies.set(SESSION_COOKIE, created.signedId, sessionCookieOptions(created.ttl));
    response.cookies.delete(OIDC_TRANSACTION_COOKIE);
    return response;
  } catch {
    return failed(request, "token_exchange_failed");
  }
}
