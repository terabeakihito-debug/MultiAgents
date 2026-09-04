// Centralized so a future server-side repository selection can replace it.
// For this MVP, npm starts Next.js from the MultiAgents repository root.
export const workspaceDirectory = process.cwd();
