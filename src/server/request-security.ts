import { isAgentExecutionActive } from "./agent-execution-guard";

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

export function rejectNonHumanProfileMutation(request: Request): Response | undefined {
  return rejectNonHumanMutation(request, "profile-save", "Profile");
}

export function rejectNonHumanTemplateMutation(request: Request): Response | undefined {
  return rejectNonHumanMutation(request, "template-save", "Task template");
}

export function rejectNonHumanFindingMutation(request: Request, action: "finding-extract" | "finding-accept" | "finding-dismiss" | "finding-convert" | "finding-priority" | "finding-resolve"): Response | undefined {
  return rejectNonHumanMutation(request, action, "Finding");
}

function rejectNonHumanMutation(request: Request, expectedAction: string, label: string): Response | undefined {
  const local = rejectNonLocalRequest(request);
  if (local) return local;
  if (isAgentExecutionActive()) return Response.json({ error: `${label} changes are blocked while an agent process is running` }, { status: 423 });
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const humanAction = request.headers.get("x-multiagents-human-action");
  if (!origin || fetchSite !== "same-origin" || humanAction !== expectedAction) {
    return Response.json({ error: `${label} changes require an explicit same-origin human UI action` }, { status: 403 });
  }
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    if (originUrl.origin !== requestUrl.origin || !LOOPBACK_HOSTS.has(originUrl.hostname)) throw new Error();
  } catch {
    return Response.json({ error: `${label} changes require the localhost UI` }, { status: 403 });
  }
}

function isLoopbackHost(hostHeader: string) {
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}
