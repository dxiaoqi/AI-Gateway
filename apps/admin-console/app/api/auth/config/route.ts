import { NextResponse } from "next/server";
import { oidcEnabled } from "@/lib/oidc";
import { localAuthStatus } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const local = await localAuthStatus();
  return NextResponse.json({
    oidcEnabled: oidcEnabled(),
    devTokenLoginEnabled: process.env.ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN === "true" && process.env.NODE_ENV !== "production",
    localAuthEnabled: local.enabled,
    localBootstrapAvailable: local.bootstrapAvailable,
  });
}
