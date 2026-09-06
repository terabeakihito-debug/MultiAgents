export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertOsSandboxAvailable } = await import("./server/os-sandbox");
  await assertOsSandboxAvailable();
}

