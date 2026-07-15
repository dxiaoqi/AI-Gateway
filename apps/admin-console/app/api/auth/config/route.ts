import { NextResponse } from "next/server";
import { oidcEnabled } from "@/lib/oidc";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    oidcEnabled: oidcEnabled(),
    devTokenLoginEnabled: process.env.ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN === "true" && process.env.NODE_ENV !== "production",
  });
}
