import type { IncomingMessage } from "node:http";

export async function readIncomingMessageBody(
  request: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function toWebRequestWithBody(request: IncomingMessage) {
  const host = request.headers.host ?? "127.0.0.1";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    }
  }

  const body = await readIncomingMessageBody(request);
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });
}
