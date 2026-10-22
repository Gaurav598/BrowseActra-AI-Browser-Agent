import { describe, expect, it } from "vitest";
import { Agent, executeAction } from "../src/agent.js";
import { DeterministicProvider } from "../src/provider.js";
import type { BrowserObservation, BrowserSession } from "../src/types.js";

class FakeSession implements BrowserSession {
  readonly id = "fake-session";
  currentUrl = "about:blank";
  pageText = "Ready";
  clicks = 0;
  closed = false;
  failClick = false;

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
  }
  async click(_selector: string): Promise<void> {
    this.clicks++;
    if (this.failClick) throw new Error("Browser disconnected after click");
    this.pageText = "Done";
  }
  async fill(_selector: string, _value: string): Promise<void> {
    this.pageText = "Filled";
  }
  async select(_selector: string, _value: string): Promise<void> {
    this.pageText = "Selected";
  }
  async text(_selector: string): Promise<string> {
    return this.pageText;
  }
  async observe(): Promise<BrowserObservation> {
    if (this.closed) throw new Error("Session closed");
    return {
      url: this.currentUrl,
      title: "Fixture",
      text: this.pageText,
      links: [],
      controls: [],
      fields: [],
    };
  }
  async inspect(): Promise<string> {
    return JSON.stringify(await this.observe());
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("BrowseActra agent", () => {
  it("requires trusted policy for effectful actions", async () => {
    const session = new FakeSession();
    const agent = new Agent(
      session,
      new DeterministicProvider([
        { type: "action", action: { type: "click", selector: "#submit" } },
      ]),
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("blocked");
    expect(session.clicks).toBe(0);
  });

  it("does not call an unverified click successful or replay it", async () => {
    const session = new FakeSession();
    const agent = new Agent(
      session,
      new DeterministicProvider([
        { type: "action", action: { type: "click", selector: "#submit" } },
      ]),
      { policy: { authorize: () => true } },
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("indeterminate");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.verification).toBe("indeterminate");
    expect(session.clicks).toBe(1);
  });

  it("verifies an explicit text postcondition against browser state", async () => {
    const session = new FakeSession();
    const agent = new Agent(
      session,
      new DeterministicProvider([
        {
          type: "action",
          action: {
            type: "click",
            selector: "#submit",
            postcondition: { kind: "text", selector: "#status", includes: "Done" },
          },
        },
        { type: "finish", output: "done" },
      ]),
      {
        policy: { authorize: () => true },
        hooks: { verifyFinish: ({ actions }) => actions.at(-1)?.verification === "verified" },
      },
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("completed");
    expect(result.actions[0]?.verification).toBe("verified");
    expect(JSON.stringify(result.actions)).not.toContain("postcondition");
  });

  it("marks a completed click with an unmet postcondition indeterminate", async () => {
    const session = new FakeSession();
    const agent = new Agent(
      session,
      new DeterministicProvider([
        {
          type: "action",
          action: {
            type: "click",
            selector: "#submit",
            postcondition: { kind: "text", selector: "#status", includes: "Payment complete" },
          },
        },
      ]),
      { policy: { authorize: () => true } },
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("indeterminate");
    expect(result.actions[0]?.verification).toBe("indeterminate");
    expect(session.clicks).toBe(1);
  });

  it("does not execute when a mutation postcondition already holds", async () => {
    const session = new FakeSession();
    session.pageText = "Done";
    const agent = new Agent(
      session,
      new DeterministicProvider([
        {
          type: "action",
          action: {
            type: "click",
            selector: "#submit",
            postcondition: { kind: "text", selector: "#status", includes: "Done" },
          },
        },
      ]),
      { policy: { authorize: () => true } },
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("indeterminate");
    expect(session.clicks).toBe(0);
  });

  it("checks real post-action state through a trusted verifier hook", async () => {
    const session = new FakeSession();
    const lifecycle: string[] = [];
    const agent = new Agent(
      session,
      new DeterministicProvider([
        { type: "action", action: { type: "click", selector: "#submit" } },
        { type: "finish", output: { submitted: true } },
      ]),
      {
        policy: { authorize: () => true },
        hooks: {
          beforeAction: ({ id, beforeDigest }) => {
            expect(id).toMatch(/[0-9a-f-]{36}/);
            expect(beforeDigest).toMatch(/^[0-9a-f]{64}$/);
            lifecycle.push("before");
          },
          afterAction: (execution) => {
            expect(execution.after?.text).toBe("Done");
            lifecycle.push("after");
          },
          verifyAction: (execution) => (execution.after?.text === "Done" ? "verified" : "rejected"),
          verifyFinish: ({ actions }) => actions.at(-1)?.verification === "verified",
        },
      },
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ submitted: true });
    expect(result.actions[0]?.verification).toBe("verified");
    expect(result.actions[0]?.after?.text).toBe("[REDACTED]");
    expect(lifecycle).toEqual(["before", "after"]);
  });

  it("marks a browser error after a possible side effect as indeterminate", async () => {
    const session = new FakeSession();
    session.failClick = true;
    const agent = new Agent(
      session,
      new DeterministicProvider([
        { type: "action", action: { type: "click", selector: "#submit" } },
      ]),
      { policy: { authorize: () => true } },
    );
    const result = await agent.run({ goal: "Submit the form" });
    expect(result.status).toBe("indeterminate");
    expect(session.clicks).toBe(1);
    expect(result.actions[0]?.executed).toBe(false);
  });

  it("redacts fill values and URL query parameters in stored action records", async () => {
    const session = new FakeSession();
    session.currentUrl = "https://example.com/form?token=secret";
    const execution = await executeAction(session, {
      type: "fill",
      selector: "#password",
      value: "secret",
    });
    expect(execution.action).toEqual({ type: "fill", selector: "#password", value: "[REDACTED]" });
    const agent = new Agent(
      session,
      new DeterministicProvider([
        { type: "action", action: { type: "text", selector: "body" } },
        { type: "finish", output: null },
      ]),
    );
    const result = await agent.run({ goal: "Read page" });
    expect(result.actions[0]?.before.url).toBe("https://example.com/form");
    expect(JSON.stringify(result.actions)).not.toContain("secret");
  });

  it("verifies navigation from actual browser URL", async () => {
    const session = new FakeSession();
    const agent = new Agent(
      session,
      new DeterministicProvider([{ type: "finish", output: "done" }]),
      {
        hooks: {
          verifyFinish: ({ observation }) => observation.url === "https://example.com/path",
        },
      },
    );
    const result = await agent.run({
      goal: "Open the page",
      initialUrl: "https://example.com/path",
    });
    expect(result.status).toBe("completed");
    expect(result.actions[0]?.verification).toBe("verified");
    expect(session.currentUrl).toBe("https://example.com/path");
  });

  it("does not trust an unverified model finish decision", async () => {
    const agent = new Agent(
      new FakeSession(),
      new DeterministicProvider([{ type: "finish", output: { success: true } }]),
    );
    const result = await agent.run({ goal: "Submit a payment" });
    expect(result.status).toBe("indeterminate");
    expect(result.output).toBeNull();
  });
});
