import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAuthorizationValues, discoverOidc, oidcConfig } from "@/lib/oidc";
import { createOidcTransaction, OIDC_TRANSACTION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = oidcConfig();
    const discovery = await discoverOidc();
    const values = createAuthorizationValues();
    const requestedReturnTo = request.nextUrl.searchParams.get("returnTo") ?? "/";
    const returnTo = requestedReturnTo.startsWith("/") && !requestedReturnTo.startsWith("//") ? requestedReturnTo : "/";
    const transaction = await createOidcTransaction({
      state: values.state,
      nonce: values.nonce,
      codeVerifier: values.codeVerifier,
      returnTo,
    });
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      state: values.state,
      nonce: values.nonce,
      code_challenge: values.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(OIDC_TRANSACTION_COOKIE, transaction.signedId, sessionCookieOptions(transaction.ttl));
    return response;
  } catch {
    const origin = process.env.ADMIN_CONSOLE_PUBLIC_ORIGIN ?? request.nextUrl.origin;
    return NextResponse.redirect(new URL("/?auth_error=oidc_unavailable", origin));
  }
}
