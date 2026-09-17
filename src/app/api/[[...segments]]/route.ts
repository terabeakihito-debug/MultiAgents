import { handleNextApiViaDaemon } from "@/server/next-api-via-daemon.mjs";

export const runtime = "nodejs";

// Human-mutation and localhost gates are enforced in the daemon HTTP router.

async function handle(request: Request) {
  return handleNextApiViaDaemon(request);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
