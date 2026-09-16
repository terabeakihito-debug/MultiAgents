import { humanSessionService } from "@/core/human-session-service";

export const runtime = "nodejs";

export function GET(request: Request) {
  return humanSessionService.issue(request);
}
