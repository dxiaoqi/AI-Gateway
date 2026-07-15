type OriginRequest = {
  headers: { get(name: string): string | null };
  nextUrl: { origin: string; protocol: string };
};

export function resolveRequestOrigin(request: OriginRequest, configured?: string) {
  if (configured) {
    try { return new URL(configured).origin; } catch { return ""; }
  }

  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(/:$/, "");
  const host = forwardedHost || request.headers.get("host");
  if (host && (protocol === "http" || protocol === "https")) {
    try { return new URL(`${protocol}://${host}`).origin; } catch { return ""; }
  }
  return request.nextUrl.origin;
}
