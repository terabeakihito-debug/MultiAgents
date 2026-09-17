import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const bridgeRoot = dirname(fileURLToPath(import.meta.url));
const daemonRouterPath = join(bridgeRoot, "../../dist-daemon/daemon/http-router.js");

/**
 * @param {import("node:http").IncomingMessage} request
 */
export function stripApiPrefixFromRequestUrl(request) {
  const rawUrl = request.url ?? "/";
  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";

  if (pathname === "/api") {
    request.url = `/${query}`;
    return true;
  }
  if (!pathname.startsWith("/api/")) {
    return false;
  }

  request.url = `${pathname.slice("/api".length) || "/"}${query}`;
  return true;
}

export function isDaemonApiBridgeEnabled() {
  return process.env.MULTIAGENTS_USE_DAEMON_API !== "0";
}

export function createDaemonApiBridge(options = {}) {
  const loadHandler =
    options.loadHandler ??
    (async () => {
      const daemonModule = await import(daemonRouterPath);
      return daemonModule.createDaemonHttpHandler();
    });

  /** @type {Promise<(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>> | undefined} */
  let handlerPromise;

  return {
    isEnabled() {
      return isDaemonApiBridgeEnabled();
    },
    async tryHandle(request, response) {
      if (!this.isEnabled()) return false;
      if (!stripApiPrefixFromRequestUrl(request)) return false;

      handlerPromise ??= loadHandler();
      const handler = await handlerPromise;
      await handler(request, response);
      return true;
    },
  };
}
