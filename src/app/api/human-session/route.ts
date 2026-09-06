import { issueHumanMutationNonce } from "@/server/request-security";

export const runtime = "nodejs";

export function GET(request: Request) {
  return issueHumanMutationNonce(request);
}
