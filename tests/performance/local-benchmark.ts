import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createApiServer } from "../../apps/api/src/server.js";
import { createBrowserExecutor } from "../../packages/browseactra-executor/src/index.js";
import { BrowseActraClient } from "../../packages/browseactra-sdk/dist/index.js";

const samples = Number(process.env.BROWSEACTRA_BENCHMARK_SAMPLES ?? "5");
if (!Number.isInteger(samples) || samples < 1 || samples > 100)
  throw new Error("Sample count must be 1 to 100");
const directory = await mkdtemp(join(tmpdir(), "browseactra-benchmark-"));
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html><head><title>Benchmark fixture</title></head><body><h1>Benchmark fixture</h1></body></html>",
  );
});
const fixturePort = await new Promise<number>((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", () => {
    const address = fixture.address();
    if (!address || typeof address === "string") reject(new Error("Fixture did not bind"));
    else resolve(address.port);
  });
});
const api = createApiServer({
  databasePath: join(directory, "jobs.db"),
  host: "127.0.0.1",
  port: 0,
  allowedHosts: ["127.0.0.1"],
  maxConcurrent: 1,
  executor: createBrowserExecutor({
    allowedHosts: ["127.0.0.1"],
    browserChannel: process.env.BROWSEACTRA_BROWSER_CHANNEL === "chrome" ? "chrome" : "chromium",
  }),
});

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
}

try {
  const { url } = await api.listen();
  const client = new BrowseActraClient({ baseUrl: url });
  const latencies: number[] = [];
  const queueWaits: number[] = [];
  let verified = 0;
  let failures = 0;
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    const initial = await client.jobs.create({
      instruction: "Read the page title",
      url: `http://127.0.0.1:${fixturePort}/`,
    });
    const job = await client.jobs.wait(initial.id, { timeoutMs: 30_000, intervalMs: 50 });
    latencies.push(Math.round(performance.now() - started));
    queueWaits.push(
      Math.max(
        0,
        new Date(job.startedAt ?? job.createdAt).getTime() - new Date(job.createdAt).getTime(),
      ),
    );
    if (
      job.status !== "completed" ||
      (job.result as { title?: string })?.title !== "Benchmark fixture"
    )
      failures++;
    const receipts = (await client.jobs.receipts(job.id)) as { status: string }[];
    verified += receipts.filter((receipt) => receipt.status === "verified").length;
  }
  process.stdout.write(
    JSON.stringify(
      {
        samples,
        provider: "deterministic",
        browserChannel:
          process.env.BROWSEACTRA_BROWSER_CHANNEL === "chrome" ? "chrome" : "chromium",
        concurrency: 1,
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          min: Math.min(...latencies),
          max: Math.max(...latencies),
        },
        queueWaitMs: { p50: percentile(queueWaits, 0.5), p95: percentile(queueWaits, 0.95) },
        verifiedReceipts: verified,
        failures,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await api.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
