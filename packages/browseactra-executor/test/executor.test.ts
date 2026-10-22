import { describe, expect, it } from "vitest";
import { DeterministicProvider, type BrowserSession } from "@browseactra/runtime";
import { createBrowserExecutor, ExecutionFailure, validateOutput } from "../src/index.js";

function fixtureSession(): BrowserSession {
  let current = "about:blank";
  let closed = false;
  return {
    id: "fixture",
    async navigate(url) {
      current = url;
    },
    async click() {
      throw new Error("unexpected click");
    },
    async fill() {
      throw new Error("unexpected fill");
    },
    async select() {
      throw new Error("unexpected select");
    },
    async text() {
      return "fixture";
    },
    async observe() {
      if (closed) throw new Error("closed");
      return {
        url: current,
        title: current === "about:blank" ? "" : "Fixture page",
        text: "Fixture content",
        links: [],
        controls: [],
        fields: [],
      };
    },
    async inspect() {
      return "{}";
    },
    async url() {
      return current;
    },
    async close() {
      closed = true;
    },
  };
}

function mutationSession(
  alreadyDone: boolean,
  onClick?: () => void,
  changeOnClick = true,
): BrowserSession {
  const base = fixtureSession();
  let done = alreadyDone;
  return {
    ...base,
    async click() {
      onClick?.();
      if (changeOnClick) done = true;
    },
    async text() {
      return done ? "Done" : "Pending";
    },
    async observe() {
      return { ...(await base.observe()), text: done ? "Done" : "Pending" };
    },
  };
}

function mutationProvider() {
  return new DeterministicProvider([
    {
      type: "action",
      action: {
        type: "click",
        selector: "#confirm",
        postcondition: { kind: "text", selector: "#status", includes: "Done" },
      },
    },
    { type: "finish", output: { title: "Fixture page" } },
  ]);
}

describe("browser executor", () => {
  it("returns observed title and persists a verified navigation receipt", async () => {
    const receipts: unknown[] = [];
    const events: string[] = [];
    const executor = createBrowserExecutor({
      browserFactory: {
        async open() {
          return fixtureSession();
        },
      },
    });
    const output = await executor.execute(
      { id: "job-1", instruction: "Read the page title", url: "https://example.com/" },
      {
        signal: new AbortController().signal,
        recordReceipt(receipt) {
          receipts.push(receipt);
        },
        recordEvent(type) {
          events.push(type);
        },
      },
    );
    expect(output).toEqual({ title: "Fixture page", url: "https://example.com/" });
    expect(receipts).toEqual([expect.objectContaining({ status: "verified" })]);
    expect(events).toContain("action.finished");
  });

  it("fails an unsupported offline instruction without inventing an outcome", async () => {
    const executor = createBrowserExecutor({
      browserFactory: {
        async open() {
          return fixtureSession();
        },
      },
    });
    await expect(
      executor.execute(
        { id: "job-2", instruction: "Purchase a book", url: "https://example.com/" },
        {
          signal: new AbortController().signal,
          recordReceipt() {},
          recordEvent() {},
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome: "failed", name: ExecutionFailure.name }));
  });

  it("validates declared structured output", () => {
    const schema = {
      type: "object" as const,
      properties: { title: { type: "string" as const } },
      required: ["title"],
      additionalProperties: false as const,
    };
    expect(validateOutput({ title: "Fixture" }, schema)).toBe(true);
    expect(validateOutput({ title: 3 }, schema)).toBe(false);
    expect(validateOutput({ title: "Fixture", secret: "extra" }, schema)).toBe(false);
  });

  it("requires an exact trusted approval for mutations", async () => {
    const executor = createBrowserExecutor({
      allowMutations: true,
      providerFactory: mutationProvider,
      browserFactory: {
        async open() {
          return mutationSession(false);
        },
      },
    });
    await expect(
      executor.execute(
        { id: "denied", instruction: "Click the button", url: "https://example.com/" },
        { signal: new AbortController().signal, recordReceipt() {}, recordEvent() {} },
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome: "failed" }));
  });

  it("verifies a mutation only when its postcondition changed after the action", async () => {
    const receipts: { status: string }[] = [];
    const executor = createBrowserExecutor({
      allowMutations: true,
      approvedMutations: [{ host: "example.com", type: "click", selector: "#confirm" }],
      providerFactory: mutationProvider,
      browserFactory: {
        async open() {
          return mutationSession(false);
        },
      },
    });
    const output = await executor.execute(
      { id: "changed", instruction: "Click the button", url: "https://example.com/" },
      {
        signal: new AbortController().signal,
        recordReceipt(receipt) {
          receipts.push(receipt);
        },
        recordEvent() {},
      },
    );
    expect(output).toEqual({ title: "Fixture page" });
    expect(receipts.at(-1)?.status).toBe("verified");
  });

  it("does not treat a pre-existing postcondition as proof of a click", async () => {
    const receipts: { status: string }[] = [];
    let clicks = 0;
    const executor = createBrowserExecutor({
      allowMutations: true,
      approvedMutations: [{ host: "example.com", type: "click", selector: "#confirm" }],
      providerFactory: mutationProvider,
      browserFactory: {
        async open() {
          return mutationSession(true, () => clicks++);
        },
      },
    });
    await expect(
      executor.execute(
        { id: "ambiguous", instruction: "Click the button", url: "https://example.com/" },
        {
          signal: new AbortController().signal,
          recordReceipt(receipt) {
            receipts.push(receipt);
          },
          recordEvent() {},
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome: "failed" }));
    expect(receipts.at(-1)?.status).toBe("rejected");
    expect(clicks).toBe(0);
  });

  it("marks an executed click with an unmet postcondition indeterminate", async () => {
    const receipts: { status: string }[] = [];
    let clicks = 0;
    const executor = createBrowserExecutor({
      allowMutations: true,
      approvedMutations: [{ host: "example.com", type: "click", selector: "#confirm" }],
      providerFactory: mutationProvider,
      browserFactory: {
        async open() {
          return mutationSession(false, () => clicks++, false);
        },
      },
    });
    await expect(
      executor.execute(
        { id: "unmet", instruction: "Click the button", url: "https://example.com/" },
        {
          signal: new AbortController().signal,
          recordReceipt(receipt) {
            receipts.push(receipt);
          },
          recordEvent() {},
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome: "indeterminate" }));
    expect(clicks).toBe(1);
    expect(receipts.at(-1)?.status).toBe("indeterminate");
  });
});
