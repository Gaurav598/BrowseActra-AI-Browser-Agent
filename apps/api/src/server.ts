import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { assertAllowedUrl } from "@browseactra/runtime";
import { IdempotencyConflict, JobStore } from "./store.js";
import type { JobExecutor, OutputSchema } from "./types.js";
import { JobWorker, type WorkerOptions } from "./worker.js";

const MAX_BODY_BYTES = 65_536;
const TERMINAL = new Set(["completed", "failed", "cancelled", "indeterminate"]);
const STATIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export interface ApiServerOptions extends WorkerOptions {
  databasePath: string;
  executor: JobExecutor;
  host?: string;
  port?: number;
  apiKey?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  webRoot?: string;
  rateLimitPerMinute?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message } });
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const actual = Buffer.from(expected);
  return given.length === actual.length && timingSafeEqual(given, actual);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body exceeds 64 KiB");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "body_too_large", "Request body exceeds 64 KiB");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function outputSchema(value: unknown): OutputSchema | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 8_192
  ) {
    throw new HttpError(
      400,
      "invalid_output_schema",
      "outputSchema must be a bounded object schema",
    );
  }
  const schema = value as Record<string, unknown>;
  if (
    Object.keys(schema).some(
      (key) =>
        !["type", "properties", "required", "additionalProperties", "description"].includes(key),
    ) ||
    schema.type !== "object" ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    throw new HttpError(400, "invalid_output_schema", "Only flat object schemas are supported");
  }
  const properties = schema.properties as Record<string, unknown>;
  const names = Object.keys(properties).sort();
  if (
    !names.length ||
    names.length > 32 ||
    names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
  ) {
    throw new HttpError(
      400,
      "invalid_output_schema",
      "outputSchema must have 1 to 32 named properties",
    );
  }
  const normalized: OutputSchema = { type: "object", properties: {} };
  for (const name of names) {
    const property = properties[name];
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      throw new HttpError(400, "invalid_output_schema", "Schema property must be an object");
    }
    const descriptor = property as Record<string, unknown>;
    if (
      Object.keys(descriptor).some((key) => !["type", "description"].includes(key)) ||
      !["string", "number", "boolean"].includes(String(descriptor.type))
    ) {
      throw new HttpError(
        400,
        "invalid_output_schema",
        "Schema property type must be string, number, or boolean",
      );
    }
    if (
      descriptor.description !== undefined &&
      (typeof descriptor.description !== "string" || descriptor.description.length > 256)
    ) {
      throw new HttpError(400, "invalid_output_schema", "Schema property description is too long");
    }
    normalized.properties[name] = {
      type: descriptor.type as "string" | "number" | "boolean",
      ...(descriptor.description === undefined
        ? {}
        : { description: descriptor.description as string }),
    };
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== "string" || !names.includes(name)) ||
      new Set(schema.required).size !== schema.required.length
    ) {
      throw new HttpError(
        400,
        "invalid_output_schema",
        "required must list unique declared properties",
      );
    }
    normalized.required = [...schema.required].sort();
  }
  if (schema.additionalProperties !== undefined) {
    if (schema.additionalProperties !== false)
      throw new HttpError(400, "invalid_output_schema", "additionalProperties must be false");
    normalized.additionalProperties = false;
  }
  if (schema.description !== undefined) {
    if (typeof schema.description !== "string" || schema.description.length > 256) {
      throw new HttpError(400, "invalid_output_schema", "Schema description is too long");
    }
    normalized.description = schema.description;
  }
  return normalized;
}

function validJobInput(
  body: Record<string, unknown>,
  allowedHosts: Set<string>,
  nonLoopback: boolean,
) {
  const { instruction, url } = body;
  if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 4_000) {
    throw new HttpError(400, "invalid_instruction", "instruction must be 1 to 4000 characters");
  }
  if (typeof url !== "string" || url.length > 2_048) {
    throw new HttpError(400, "invalid_url", "url must be an HTTP or HTTPS URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "invalid_url", "url must be an HTTP or HTTPS URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new HttpError(400, "invalid_url", "url must be an HTTP or HTTPS URL without credentials");
  }
  try {
    assertAllowedUrl(parsed.href, [...allowedHosts]);
  } catch {
    throw new HttpError(
      403,
      "target_not_allowed",
      "Target requires an explicit trusted host allowlist",
    );
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new HttpError(403, "target_not_allowed", "Target host is not in the allowlist");
  }
  if (nonLoopback && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new HttpError(403, "target_not_allowed", "Target host is not in the allowlist");
  }
  return {
    instruction: instruction.trim(),
    url: parsed.href,
    outputSchema: outputSchema(body.outputSchema),
  };
}

function loopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function hostName(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  if (hostHeader.startsWith("[")) {
    const close = hostHeader.indexOf("]");
    return close < 0 ? null : hostHeader.slice(1, close);
  }
  return hostHeader.split(":", 1)[0] || null;
}

function integerParam(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new HttpError(400, "invalid_query", "Query parameter must be a nonnegative integer");
  }
  return number;
}

export function createApiServer(options: ApiServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const nonLoopback = !loopback(host);
  if (nonLoopback && (!options.apiKey || options.apiKey.length < 24)) {
    throw new Error("Non-loopback bind requires an API key of at least 24 characters");
  }
  const allowedHosts = new Set((options.allowedHosts ?? []).map((name) => name.toLowerCase()));
  if (nonLoopback && allowedHosts.size === 0) {
    throw new Error("Non-loopback bind requires an explicit target host allowlist");
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const webRoot = options.webRoot ?? fileURLToPath(new URL("../../web/", import.meta.url));
  const store = new JobStore(options.databasePath);
  const worker = new JobWorker(store, options.executor, options);
  const rateLimit = options.rateLimitPerMinute ?? 120;
  if (!Number.isInteger(rateLimit) || rateLimit < 1)
    throw new Error("rateLimitPerMinute must be positive");
  const rates = new Map<string, { window: number; count: number }>();
  const streams = new Set<ServerResponse>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const incomingHost = hostName(request.headers.host);
      if (loopback(host) && incomingHost && !loopback(incomingHost)) {
        throw new HttpError(403, "invalid_host", "Host is not allowed for a local API");
      }
      const origin = request.headers.origin;
      if (origin) {
        const own = `http://${request.headers.host}`;
        if (origin !== own && !allowedOrigins.has(origin)) {
          throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
        }
        response.setHeader("vary", "Origin");
        if (allowedOrigins.has(origin)) response.setHeader("access-control-allow-origin", origin);
      }
      if (method === "OPTIONS" && path.startsWith("/api/v1/")) {
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
      if (method === "GET" && STATIC.has(path)) {
        const [file, contentType] = STATIC.get(path)!;
        try {
          const content = await readFile(resolve(webRoot, file));
          response.writeHead(200, {
            "content-type": contentType,
            "content-security-policy":
              "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; object-src 'none'",
            "x-content-type-options": "nosniff",
          });
          response.end(content);
        } catch {
          throw new HttpError(404, "not_found", "Page not found");
        }
        return;
      }
      if (method === "GET" && path === "/health") return sendJson(response, 200, { status: "ok" });
      if (method === "GET" && path === "/ready") {
        store.db.prepare("SELECT 1").get();
        return sendJson(response, 200, { status: "ready" });
      }
      if (!path.startsWith("/api/v1/")) throw new HttpError(404, "not_found", "Route not found");
      if (options.apiKey && !bearerMatches(request.headers.authorization, options.apiKey)) {
        throw new HttpError(401, "unauthorized", "Bearer API key required");
      }
      const ip = request.socket.remoteAddress ?? "unknown";
      const window = Math.floor(Date.now() / 60_000);
      const rate = rates.get(ip);
      const count = rate?.window === window ? rate.count + 1 : 1;
      rates.set(ip, { window, count });
      if (rates.size > 1_000) {
        for (const [key, value] of rates) if (value.window !== window) rates.delete(key);
      }
      if (count > rateLimit) throw new HttpError(429, "rate_limited", "Rate limit exceeded");

      if (path === "/api/v1/jobs") {
        if (method === "GET") {
          const limit = integerParam(url.searchParams.get("limit"), 50, 100);
          return sendJson(response, 200, { jobs: store.list(limit) });
        }
        if (method === "POST") {
          const keyHeader = request.headers["idempotency-key"];
          const key = Array.isArray(keyHeader) ? null : keyHeader;
          if (key !== undefined && (key === null || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) {
            throw new HttpError(
              400,
              "invalid_idempotency_key",
              "Idempotency-Key must be 1 to 128 safe characters",
            );
          }
          const input = validJobInput(await readJsonBody(request), allowedHosts, nonLoopback);
          let created;
          try {
            created = store.create(input, key);
          } catch (error) {
            if (error instanceof IdempotencyConflict)
              throw new HttpError(409, "idempotency_conflict", error.message);
            throw error;
          }
          if (created.created) worker.wake();
          return sendJson(response, created.created ? 202 : 200, { job: created.job });
        }
        throw new HttpError(405, "method_not_allowed", "Method not allowed");
      }
      const match = /^\/api\/v1\/jobs\/([^/]+)(?:\/(cancel|events|receipts))?$/.exec(path);
      if (!match) throw new HttpError(404, "not_found", "Route not found");
      const id = decodeURIComponent(match[1]);
      if (id.length > 128) throw new HttpError(404, "not_found", "Job not found");
      const job = store.get(id);
      if (!job) throw new HttpError(404, "not_found", "Job not found");
      const subroute = match[2];
      if (!subroute && method === "GET") return sendJson(response, 200, { job });
      if (subroute === "cancel" && method === "POST") {
        const updated = store.cancel(id)!;
        if (updated.status === "cancel_requested") worker.cancel(id);
        return sendJson(response, 200, { job: updated });
      }
      if (subroute === "receipts" && method === "GET")
        return sendJson(response, 200, { receipts: store.receipts(id) });
      if (subroute === "events" && method === "GET") {
        const after = integerParam(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
        if (!request.headers.accept?.includes("text/event-stream")) {
          return sendJson(response, 200, { events: store.events(id, after) });
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
        });
        streams.add(response);
        let cursor = after;
        const flush = () => {
          for (const event of store.events(id, cursor)) {
            cursor = event.id;
            response.write(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          }
          const latest = store.get(id);
          if (latest && TERMINAL.has(latest.status)) {
            clearInterval(timer);
            response.end();
          }
        };
        const timer = setInterval(flush, 250);
        timer.unref();
        request.on("close", () => {
          clearInterval(timer);
          streams.delete(response);
        });
        flush();
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) return sendError(response, error);
      // Avoid reflecting internal errors, file paths, or stored credentials to clients.
      sendError(response, new HttpError(500, "internal_error", "Internal server error"));
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  return {
    store,
    worker,
    server,
    async listen(): Promise<{ host: string; port: number; url: string }> {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolveListen();
        });
      });
      worker.start();
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("API did not bind a TCP address");
      return {
        host,
        port: address.port,
        url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
      };
    },
    async close(): Promise<void> {
      await worker.close();
      for (const stream of streams) stream.end();
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
      store.close();
    },
  };
}
