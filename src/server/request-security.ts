import { createHash, randomBytes } from "node:crypto";
import { isAgentExecutionActive } from "./agent-execution-guard";
import type { HumanMutationAction } from "../security/human-actions";
import { canAdmitMutations, lifecycleState } from "./operation-registry";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HUMAN_SESSION_COOKIE = "multiagents_human_session";
const NONCE_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_NONCES_PER_SESSION = 8;

type HumanSession = { expiresAt: number; nonces: Map<string, number> };
const shared = globalThis as typeof globalThis & { __multiAgentsHumanSessions?: Map<string, HumanSession> };
const humanSessions = shared.__multiAgentsHumanSessions ??= new Map<string, HumanSession>();

export function rejectNonLocalRequest(request: Request): Response | undefined {
  const hostHeader = request.headers.get("host");
  if (!hostHeader || !isLoopbackHost(hostHeader)) {
    return Response.json({ error: "This API is available only on localhost" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(origin).hostname)) return Response.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
    } catch {
      return Response.json({ error: "Invalid Origin header" }, { status: 403 });
    }
  }
}

export function issueHumanMutationNonce(request: Request, now = Date.now()): Response {
  const local = rejectNonLocalRequest(request);
  if (local) return local;
  if (request.method !== "GET") return methodRejected("GET");
  if (isAgentExecutionActive()) return humanGateRejected("nonce-issue", "agent_active", 423, "Human actions are blocked while an agent process is running");
  if (request.headers.get("sec-fetch-site") !== "same-origin" || !hasExactSameOriginReferrer(request)) {
    return humanGateRejected("nonce-issue", "not_same_origin_ui", 403, "A same-origin UI session is required");
  }

  pruneSessions(now);
  const cookies = parseCookies(request.headers.get("cookie"));
  let sessionId = cookies.get(HUMAN_SESSION_COOKIE);
  let session = sessionId ? humanSessions.get(sessionId) : undefined;
  if (!session || session.expiresAt <= now) {
    sessionId = randomBytes(32).toString("base64url");
    session = { expiresAt: now + SESSION_TTL_MS, nonces: new Map() };
    humanSessions.set(sessionId, session);
  }
  session.expiresAt = now + SESSION_TTL_MS;
  pruneNonces(session, now);
  while (session.nonces.size >= MAX_NONCES_PER_SESSION) session.nonces.delete(session.nonces.keys().next().value!);
  const nonce = randomBytes(32).toString("base64url");
  session.nonces.set(hashNonce(nonce), now + NONCE_TTL_MS);

  return Response.json({ nonce, expiresAt: new Date(now + NONCE_TTL_MS).toISOString() }, {
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": `${HUMAN_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    },
  });
}

export function requireHumanMutation(
  request: Request,
  expectedAction: HumanMutationAction,
  options: { method?: "POST" | "DELETE"; label?: string; now?: number } = {},
): Response | undefined {
  const local = rejectNonLocalRequest(request);
  if (local) return auditExistingRejection(expectedAction, "non_local", local);
  const method = options.method ?? "POST";
  if (request.method !== method) return auditExistingRejection(expectedAction, "wrong_method", methodRejected(method));
  const label = options.label ?? "Mutation";
  if (isAgentExecutionActive()) return humanGateRejected(expectedAction, "agent_active", 423, `${label} changes are blocked while an agent process is running`);
  if ((lifecycleState() !== "RUNNING" || !canAdmitMutations()) && expectedAction !== "maintenance-mode") {
    return humanGateRejected(expectedAction, "server_draining", 503, `${label} changes are blocked while the server is draining`);
  }

  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const humanAction = request.headers.get("x-multiagents-human-action");
  if (!origin || fetchSite !== "same-origin" || humanAction !== expectedAction) {
    return humanGateRejected(expectedAction, "missing_human_signal", 403, `${label} changes require an explicit same-origin human UI action`);
  }
  try {
    const originUrl = new URL(origin);
    const hostHeader = request.headers.get("host");
    if (!hostHeader || originUrl.origin !== loopbackOrigin(hostHeader) || !LOOPBACK_HOSTS.has(originUrl.hostname)) throw new Error();
  } catch {
    return humanGateRejected(expectedAction, "origin_mismatch", 403, `${label} changes require the exact localhost UI origin`);
  }

  const now = options.now ?? Date.now();
  pruneSessions(now);
  const sessionId = parseCookies(request.headers.get("cookie")).get(HUMAN_SESSION_COOKIE);
  const nonce = request.headers.get("x-multiagents-human-nonce");
  const session = sessionId ? humanSessions.get(sessionId) : undefined;
  const nonceHash = nonce ? hashNonce(nonce) : undefined;
  const expiresAt = session && nonceHash ? session.nonces.get(nonceHash) : undefined;
  if (!session || !nonceHash || expiresAt === undefined || expiresAt <= now) {
    if (session && nonceHash) session.nonces.delete(nonceHash);
    return humanGateRejected(expectedAction, expiresAt !== undefined ? "expired_nonce" : "invalid_nonce", 403, `${label} changes require a valid short-lived human nonce`);
  }
  session.nonces.delete(nonceHash);
}

export function rejectNonHumanProfileMutation(request: Request): Response | undefined {
  return requireHumanMutation(request, "profile-save", { label: "Profile" });
}

export function rejectNonHumanTemplateMutation(request: Request): Response | undefined {
  return requireHumanMutation(request, "template-save", { label: "Task template" });
}

export function rejectNonHumanFindingMutation(request: Request, action: Extract<HumanMutationAction, `finding-${string}`>): Response | undefined {
  return requireHumanMutation(request, action, { label: "Finding" });
}

export function rejectNonHumanNotificationMutation(request: Request, action: Extract<HumanMutationAction, `notification-${string}`>): Response | undefined {
  return requireHumanMutation(request, action, { label: "Notification" });
}

export function rejectNonHumanOutboundMutation(request: Request, action: Extract<HumanMutationAction, `outbound-${string}`>): Response | undefined {
  return requireHumanMutation(request, action, { label: "External notification" });
}

export function clearHumanMutationSessionsForTests() {
  humanSessions.clear();
}

function hasExactSameOriginReferrer(request: Request) {
  const referrer = request.headers.get("referer");
  const hostHeader = request.headers.get("host");
  if (!referrer || !hostHeader) return false;
  try {
    const referrerUrl = new URL(referrer);
    return referrerUrl.origin === loopbackOrigin(hostHeader) && LOOPBACK_HOSTS.has(referrerUrl.hostname);
  } catch {
    return false;
  }
}

function loopbackOrigin(hostHeader: string) {
  return new URL(`http://${hostHeader}`).origin;
}

function isLoopbackHost(hostHeader: string) {
  try { return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname); }
  catch { return false; }
}

function parseCookies(header: string | null) {
  const result = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) result.set(name, value);
  }
  return result;
}

function hashNonce(nonce: string) {
  return createHash("sha256").update(nonce).digest("hex");
}

function pruneNonces(session: HumanSession, now: number) {
  for (const [nonce, expiresAt] of session.nonces) if (expiresAt <= now) session.nonces.delete(nonce);
}

function pruneSessions(now: number) {
  for (const [id, session] of humanSessions) {
    pruneNonces(session, now);
    if (session.expiresAt <= now) humanSessions.delete(id);
  }
}

function methodRejected(method: string) {
  return Response.json({ error: `Method must be ${method}` }, { status: 405, headers: { Allow: method } });
}

function humanGateRejected(action: string, reason: string, status: number, message: string) {
  console.warn("security_audit", JSON.stringify({ type: "human_gate_rejected", action, reason }));
  return Response.json({ error: message }, { status });
}

function auditExistingRejection(action: string, reason: string, response: Response) {
  console.warn("security_audit", JSON.stringify({ type: "human_gate_rejected", action, reason }));
  return response;
}
