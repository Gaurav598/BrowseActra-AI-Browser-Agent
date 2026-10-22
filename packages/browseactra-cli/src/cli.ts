#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowseActraClient } from "@browseactra/sdk";

const help = `BrowseActra — local AI browser automation

Usage:
  browseactra dev                          Start the local API and worker
  browseactra run <instruction> --url URL  Submit and wait for a browser job
  browseactra jobs list                    List jobs
  browseactra jobs inspect ID              Show job, receipts, and events
  browseactra jobs cancel ID               Request cancellation

Environment:
  BROWSEACTRA_API_URL  API base URL (default http://127.0.0.1:3000)
  BROWSEACTRA_API_KEY  Optional API bearer key
`;

function client(): BrowseActraClient {
  return new BrowseActraClient({
    baseUrl: process.env.BROWSEACTRA_API_URL ?? "http://127.0.0.1:3000",
    apiKey: process.env.BROWSEACTRA_API_KEY,
  });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(help);
    return 0;
  }
  if (command === "dev") {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const child = spawn("pnpm", ["--dir", "apps/api", "dev"], {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: process.env,
    });
    return new Promise<number>((resolve) => {
      child.on("error", (error) => {
        process.stderr.write(`${error.message}\n`);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 1));
      process.on("SIGINT", () => child.kill("SIGINT"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
    });
  }
  const api = client();
  if (command === "run") {
    const urlIndex = args.indexOf("--url");
    const url = urlIndex === -1 ? undefined : args[urlIndex + 1];
    const instruction = args
      .slice(1, urlIndex === -1 ? undefined : urlIndex)
      .join(" ")
      .trim();
    if (!instruction || !url) throw new Error("run requires an instruction and --url URL");
    const job = await api.jobs.create({ instruction, url });
    process.stdout.write(JSON.stringify(await api.jobs.wait(job.id), null, 2) + "\n");
    return 0;
  }
  if (command === "jobs" && subcommand === "list") {
    process.stdout.write(JSON.stringify(await api.jobs.list(), null, 2) + "\n");
    return 0;
  }
  if (command === "jobs" && subcommand === "inspect" && rest[0]) {
    const id = rest[0];
    const [job, receipts, events] = await Promise.all([
      api.jobs.get(id),
      api.jobs.receipts(id),
      api.jobs.events(id),
    ]);
    process.stdout.write(JSON.stringify({ job, receipts, events }, null, 2) + "\n");
    return 0;
  }
  if (command === "jobs" && subcommand === "cancel" && rest[0]) {
    process.stdout.write(JSON.stringify(await api.jobs.cancel(rest[0]), null, 2) + "\n");
    return 0;
  }
  throw new Error(`Unknown command. Run browseactra --help`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
