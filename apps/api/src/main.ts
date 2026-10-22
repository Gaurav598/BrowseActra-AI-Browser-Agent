import { createBrowserExecutor, type ExecutorOptions } from "@browseactra/executor";
import { createApiServer } from "./server.js";

function list(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535)
    throw new Error("BROWSEACTRA_PORT must be a valid TCP port");
  return parsed;
}

function approvedMutations(value: string | undefined): ExecutorOptions["approvedMutations"] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length > 100 ||
    !parsed.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.host === "string" &&
        entry.host.length > 0 &&
        entry.host.length <= 253 &&
        ["click", "fill", "select"].includes(entry.type) &&
        typeof entry.selector === "string" &&
        entry.selector.length > 0 &&
        entry.selector.length <= 300,
    )
  )
    throw new Error(
      "BROWSEACTRA_APPROVED_MUTATIONS must be a bounded JSON array of host, type, and selector entries",
    );
  return parsed;
}

const allowedHosts = list(process.env.BROWSEACTRA_ALLOWED_HOSTS);
const executor = createBrowserExecutor({
  modelApiKey: process.env.BROWSEACTRA_MODEL_API_KEY,
  modelName: process.env.BROWSEACTRA_MODEL_NAME,
  modelBaseUrl: process.env.BROWSEACTRA_MODEL_BASE_URL,
  allowedHosts,
  browserChannel: process.env.BROWSEACTRA_BROWSER_CHANNEL === "chrome" ? "chrome" : "chromium",
  browserExecutablePath: process.env.BROWSEACTRA_BROWSER_EXECUTABLE_PATH,
  allowMutations: process.env.BROWSEACTRA_ALLOW_MUTATIONS === "true",
  approvedMutations: approvedMutations(process.env.BROWSEACTRA_APPROVED_MUTATIONS),
});

const api = createApiServer({
  databasePath: process.env.BROWSEACTRA_DATABASE_PATH ?? "./data/browseactra.db",
  host: process.env.BROWSEACTRA_HOST ?? "127.0.0.1",
  port: port(process.env.BROWSEACTRA_PORT),
  apiKey: process.env.BROWSEACTRA_API_KEY,
  allowedHosts,
  allowedOrigins: list(process.env.BROWSEACTRA_ALLOWED_ORIGINS),
  maxConcurrent: Number(process.env.BROWSEACTRA_MAX_CONCURRENT ?? "2"),
  executor,
});

const address = await api.listen();
process.stdout.write(
  JSON.stringify({
    level: "info",
    event: "server.listening",
    url: address.url,
    at: new Date().toISOString(),
  }) + "\n",
);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void api.close().then(
      () => {
        process.stdout.write(
          JSON.stringify({ level: "info", event: "server.stopped", at: new Date().toISOString() }) +
            "\n",
        );
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
}
