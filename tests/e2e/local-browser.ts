import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createApiServer } from "../../apps/api/src/server.js";
import { createBrowserExecutor } from "../../packages/browseactra-executor/src/index.js";
import { BrowseActraClient } from "../../packages/browseactra-sdk/dist/index.js";
import { DeterministicProvider } from "../../packages/browseactra-runtime/src/provider.js";

const execFileAsync = promisify(execFile);

const directory = await mkdtemp(join(tmpdir(), "browseactra-e2e-"));
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><html><head><title>BrowseActra fixture</title></head><body><h1>Local browser test</h1><button id="confirm" onclick="document.querySelector(\'#status\').textContent=\'Done\'">Confirm</button><p id="status">Pending</p></body></html>',
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
  databasePath: join(directory, "jobs.sqlite"),
  host: "127.0.0.1",
  port: 0,
  allowedHosts: ["127.0.0.1"],
  executor: createBrowserExecutor({
    allowedHosts: ["127.0.0.1"],
    browserChannel: process.env.BROWSEACTRA_BROWSER_CHANNEL === "chrome" ? "chrome" : "chromium",
  }),
});

const mutationApi = createApiServer({
  databasePath: join(directory, "mutation-jobs.sqlite"),
  host: "127.0.0.1",
  port: 0,
  allowedHosts: ["127.0.0.1"],
  executor: createBrowserExecutor({
    allowedHosts: ["127.0.0.1"],
    browserChannel: process.env.BROWSEACTRA_BROWSER_CHANNEL === "chrome" ? "chrome" : "chromium",
    allowMutations: true,
    approvedMutations: [{ host: "127.0.0.1", type: "click", selector: "#confirm" }],
    providerFactory: () =>
      new DeterministicProvider([
        {
          type: "action",
          action: {
            type: "click",
            selector: "#confirm",
            postcondition: { kind: "text", selector: "#status", includes: "Done" },
          },
        },
        { type: "action", action: { type: "text", selector: "#status" } },
        { type: "finish", output: "Done" },
      ]),
  }),
});

try {
  const { url } = await api.listen();
  const created = await fetch(`${url}/api/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instruction: "Read the page title",
      url: `http://127.0.0.1:${fixturePort}/`,
    }),
  });
  if (created.status !== 202)
    throw new Error(`Job create returned HTTP ${created.status}: ${await created.text()}`);
  const { job: initial } = (await created.json()) as { job: { id: string } };
  const deadline = Date.now() + 30_000;
  let job: { status: string; result?: { title: string }; error?: string } | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/v1/jobs/${initial.id}`);
    job = ((await response.json()) as { job: typeof job }).job;
    if (job && ["completed", "failed", "cancelled", "indeterminate"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (job?.status !== "completed" || job.result?.title !== "BrowseActra fixture") {
    const events = await (await fetch(`${url}/api/v1/jobs/${initial.id}/events`)).json();
    const receipts = await (await fetch(`${url}/api/v1/jobs/${initial.id}/receipts`)).json();
    throw new Error(`Browser job did not complete: ${JSON.stringify({ job, events, receipts })}`);
  }
  const receipts = (await (await fetch(`${url}/api/v1/jobs/${initial.id}/receipts`)).json()) as {
    receipts: { status: string }[];
  };
  if (receipts.receipts.length < 1 || receipts.receipts[0].status !== "verified") {
    throw new Error(`No verified browser action receipt: ${JSON.stringify(receipts)}`);
  }
  const page = await fetch(url);
  if (page.status !== 200 || !(await page.text()).includes("BrowseActra")) {
    throw new Error("BrowseActra UI is not served by the API");
  }
  const schemaRequest = {
    instruction: "Read the page title",
    url: `http://127.0.0.1:${fixturePort}/`,
    outputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  };
  const client = new BrowseActraClient({ baseUrl: url });
  const schemaInitial = await client.jobs.create({
    ...schemaRequest,
    idempotencyKey: "schema-fixture",
  });
  const sameJob = await client.jobs.create({ ...schemaRequest, idempotencyKey: "schema-fixture" });
  if (sameJob.id !== schemaInitial.id) throw new Error("Idempotency replay created a second job");
  let schemaJob: { status: string; result?: { title: string }; error?: string } | undefined;
  while (Date.now() < deadline + 30_000) {
    const response = await fetch(`${url}/api/v1/jobs/${schemaInitial.id}`);
    schemaJob = ((await response.json()) as { job: typeof schemaJob }).job;
    if (
      schemaJob &&
      ["completed", "failed", "cancelled", "indeterminate"].includes(schemaJob.status)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (
    schemaJob?.status !== "completed" ||
    schemaJob.result?.title !== "BrowseActra fixture" ||
    Object.keys(schemaJob.result).length !== 1
  ) {
    throw new Error(`Structured browser job did not complete: ${JSON.stringify(schemaJob)}`);
  }
  const schemaReceipts = (await (
    await fetch(`${url}/api/v1/jobs/${schemaInitial.id}/receipts`)
  ).json()) as { receipts: { actionId: string; status: string }[] };
  if (
    !schemaReceipts.receipts.some(
      (receipt) => receipt.actionId === "output-schema" && receipt.status === "verified",
    )
  ) {
    throw new Error("Structured output verification receipt was not persisted");
  }
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/browseactra-cli/dist/cli.js",
      "run",
      "Read the page title",
      "--url",
      `http://127.0.0.1:${fixturePort}/`,
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, BROWSEACTRA_API_URL: url },
      timeout: 30_000,
    },
  );
  const cliJob = JSON.parse(stdout) as { status: string; result?: { title: string } };
  if (cliJob.status !== "completed" || cliJob.result?.title !== "BrowseActra fixture") {
    throw new Error(`CLI did not return a real completed job: ${stdout}`);
  }
  const failed = await client.jobs.create({
    instruction: "Purchase a book",
    url: `http://127.0.0.1:${fixturePort}/`,
  });
  const failedResult = await client.jobs.wait(failed.id, { timeoutMs: 30_000 });
  if (failedResult.status !== "failed")
    throw new Error(`Unsafe unsupported task did not fail closed: ${JSON.stringify(failedResult)}`);
  const { url: mutationUrl } = await mutationApi.listen();
  const mutationClient = new BrowseActraClient({ baseUrl: mutationUrl });
  const mutationJob = await mutationClient.jobs.create({
    instruction: "Click the confirm button and read its status",
    url: `http://127.0.0.1:${fixturePort}/`,
  });
  const mutationResult = await mutationClient.jobs.wait(mutationJob.id, { timeoutMs: 30_000 });
  if (mutationResult.status !== "completed" || mutationResult.result !== "Done")
    throw new Error(`Real browser click did not complete: ${JSON.stringify(mutationResult)}`);
  const mutationReceipts = await mutationClient.jobs.receipts(mutationJob.id);
  if (
    !mutationReceipts.some(
      (receipt) =>
        receipt.status === "verified" &&
        receipt.metadata &&
        typeof receipt.metadata === "object" &&
        "action" in receipt.metadata &&
        receipt.metadata.action === "click",
    )
  )
    throw new Error(
      `Verified click receipt was not persisted: ${JSON.stringify(mutationReceipts)}`,
    );
  process.stdout.write(
    `PASS local browser workflow: API, SDK, CLI, UI; real click, verified receipts and failure status persisted\n`,
  );
} finally {
  await mutationApi.close();
  await api.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
