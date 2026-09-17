export function createIncomingMessageFromWebRequest(
  request: Request,
): Promise<import("node:http").IncomingMessage>;

export function handleNextApiViaDaemon(request: Request): Promise<Response>;
