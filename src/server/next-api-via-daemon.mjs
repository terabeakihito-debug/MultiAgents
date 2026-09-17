import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const daemonRouterPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist-daemon/daemon/http-router.js",
);

/** @type {Promise<(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>> | undefined} */
let handlerPromise;

async function loadDaemonHandler() {
  handlerPromise ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ daemonRouterPath).then((module) =>
    module.createDaemonHttpHandler(),
  );
  return handlerPromise;
}

/**
 * @param {Request} request
 */
export async function createIncomingMessageFromWebRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());

  const stream = body.length > 0 ? Readable.from([body]) : Readable.from([]);
  /** @type {import("node:http").IncomingMessage} */
  const incoming = stream;
  incoming.method = request.method;
  incoming.url = `${pathname}${url.search}`;
  incoming.headers = Object.fromEntries(request.headers.entries());
  if (!incoming.headers.host) {
    incoming.headers.host = url.host;
  }
  return incoming;
}

/**
 * @param {import("node:http").ServerResponse} response
 */
function createWebResponseCollector() {
  /** @type {import("node:stream/web").ReadableStreamDefaultController<Uint8Array> | undefined} */
  let streamController;
  const pendingStreamChunks = [];
  let streamDone = false;
  let streamError;
  let resolveStreamingHeaders;
  const streamingHeaders = new Promise((resolve) => {
    resolveStreamingHeaders = resolve;
  });
  const chunks = [];
  /** @type {Map<string, string>} */
  const headers = new Map();
  let streaming = false;

  const response = {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      if (name.toLowerCase() === "content-type" && String(value).includes("text/event-stream")) {
        streaming = true;
        resolveStreamingHeaders?.();
      }
      return response;
    },
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (streaming) {
        const value = new Uint8Array(buffer);
        if (streamController) streamController.enqueue(value);
        else pendingStreamChunks.push(value);
      } else {
        chunks.push(buffer);
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) {
        response.write(chunk);
      }
      if (streaming) {
        streamDone = true;
        streamController?.close();
      }
      return response;
    },
  };

  return {
    response,
    streamingHeaders,
    isStreaming() {
      return streaming;
    },
    fail(error) {
      streamError = error;
      streamController?.error(error);
    },
    toWebResponse() {
      if (streaming) {
        const readable = new ReadableStream({
          start(controller) {
            streamController = controller;
            for (const chunk of pendingStreamChunks) controller.enqueue(chunk);
            pendingStreamChunks.length = 0;
            if (streamError) controller.error(streamError);
            else if (streamDone) controller.close();
          },
        });
        return new Response(readable, {
          status: response.statusCode,
          headers: Object.fromEntries(headers.entries()),
        });
      }
      return new Response(Buffer.concat(chunks), {
        status: response.statusCode,
        headers: Object.fromEntries(headers.entries()),
      });
    },
  };
}

/**
 * @param {Request} request
 */
export async function handleNextApiViaDaemon(request) {
  const incoming = await createIncomingMessageFromWebRequest(request);
  const collector = createWebResponseCollector();
  const handler = await loadDaemonHandler();
  const handlerPromise = handler(incoming, collector.response);
  handlerPromise.catch((error) => collector.fail(error));
  await Promise.race([collector.streamingHeaders, handlerPromise]);
  if (!collector.isStreaming()) await handlerPromise;
  return collector.toWebResponse();
}
