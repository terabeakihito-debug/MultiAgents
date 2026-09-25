import { access, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, sep } from "node:path";

const bridgeRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(bridgeRoot, "../..");
const nextStaticRoot = join(projectRoot, ".next/static");
const nextAppHtmlRoot = join(projectRoot, ".next/server/app");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * @param {string} root
 * @param {string} relativePath
 */
export function resolvePathUnderRoot(root, relativePath) {
  const normalizedRoot = `${normalize(root)}${sep}`;
  const candidate = normalize(join(root, relativePath));
  if (candidate === normalize(root) || candidate.startsWith(normalizedRoot)) {
    return candidate;
  }
  return null;
}

/**
 * @param {string} pathname
 */
export function mapPathnameToAppHtml(pathname) {
  const trimmed = pathname.replace(/\/$/, "") || "/";
  if (trimmed === "/") {
    return join(nextAppHtmlRoot, "index.html");
  }
  return join(nextAppHtmlRoot, `${trimmed.slice(1)}.html`);
}

/**
 * @param {string} pathname
 */
export function mapPathnameToStaticAsset(pathname) {
  if (!pathname.startsWith("/_next/static/")) {
    return null;
  }
  return join(nextStaticRoot, pathname.slice("/_next/static/".length));
}

function contentTypeFor(filePath) {
  const extension = filePath.slice(filePath.lastIndexOf("."));
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * @param {import("node:http").IncomingMessage} request
 */
export function parseRequestPathname(request) {
  const rawUrl = request.url ?? "/";
  const queryIndex = rawUrl.indexOf("?");
  return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} filePath
 * @param {number} statusCode
 */
async function sendFile(response, filePath, statusCode = 200) {
  const fileStat = await stat(filePath);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentTypeFor(filePath));
  response.setHeader("Content-Length", String(fileStat.size));
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("error", reject)
      .on("end", resolve)
      .pipe(response);
  });
}

export function createNextStaticUiBridge(options = {}) {
  const development = options.development ?? false;
  let active = !development;
  let checkedBuild = false;

  async function ensureBuildAvailable() {
    if (checkedBuild) return active;
    checkedBuild = true;
    if (development) {
      active = false;
      return active;
    }
    try {
      await access(join(nextAppHtmlRoot, "index.html"));
      active = true;
    } catch {
      active = false;
    }
    return active;
  }

  return {
    async isActive() {
      return ensureBuildAvailable();
    },
    shouldFallbackToNextHandler() {
      return development || !active;
    },
    async tryHandle(request, response) {
      if (!(await ensureBuildAvailable())) return false;
      if (request.method !== "GET" && request.method !== "HEAD") return false;

      const pathname = parseRequestPathname(request);
      if (pathname.startsWith("/api")) return false;

      const staticAsset = mapPathnameToStaticAsset(pathname);
      const htmlPath = staticAsset ? null : mapPathnameToAppHtml(pathname);
      const candidate = staticAsset ?? htmlPath;
      if (!candidate) return false;

      const root = staticAsset ? nextStaticRoot : nextAppHtmlRoot;
      const relative = candidate.slice(root.length + 1);
      const safePath = resolvePathUnderRoot(root, relative);
      if (!safePath) return false;

      try {
        await access(safePath);
      } catch {
        if (staticAsset) return false;
        const notFound = resolvePathUnderRoot(nextAppHtmlRoot, "_not-found.html");
        if (!notFound) return false;
        try {
          await access(notFound);
        } catch {
          return false;
        }
        if (request.method === "HEAD") {
          response.statusCode = 404;
          response.end();
          return true;
        }
        await sendFile(response, notFound, 404);
        return true;
      }

      if (request.method === "HEAD") {
        const fileStat = await stat(safePath);
        response.statusCode = 200;
        response.setHeader("Content-Type", contentTypeFor(safePath));
        response.setHeader("Content-Length", String(fileStat.size));
        response.end();
        return true;
      }

      await sendFile(response, safePath);
      return true;
    },
  };
}
