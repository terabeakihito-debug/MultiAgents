const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function rejectNonLocalRequest(request: Request): Response | undefined {
  const hostHeader = request.headers.get("host");
  if (!hostHeader || !isLoopbackHost(hostHeader)) {
    return Response.json({ error: "This API is available only on localhost" }, { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(origin).hostname)) {
        return Response.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
      }
    } catch {
      return Response.json({ error: "Invalid Origin header" }, { status: 403 });
    }
  }
}

function isLoopbackHost(hostHeader: string) {
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}
