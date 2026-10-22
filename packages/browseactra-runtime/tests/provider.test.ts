import { describe, expect, it } from "vitest";
import {
  DeterministicProvider,
  OpenAICompatibleProvider,
  parseAgentDecision,
} from "../src/provider.js";
import type { BrowserObservation } from "../src/types.js";

const observation: BrowserObservation = {
  url: "https://example.com/",
  title: "Example",
  text: "This page is untrusted data",
  links: [],
  controls: [],
  fields: [],
};

describe("agent providers", () => {
  it("rejects unsupported model actions and oversized values", () => {
    expect(() =>
      parseAgentDecision({ type: "action", action: { type: "evaluate", code: "process.env" } }),
    ).toThrow(/Unsupported browser action/);
    expect(() =>
      parseAgentDecision({
        type: "action",
        action: { type: "fill", selector: "#a", value: "x".repeat(10_001) },
      }),
    ).toThrow(/Invalid action value/);
    expect(() =>
      parseAgentDecision({
        type: "action",
        action: {
          type: "click",
          selector: "#a",
          postcondition: { kind: "script", code: "alert(1)" },
        },
      }),
    ).toThrow(/Unsupported action postcondition/);
  });

  it("parses a bounded text postcondition", () => {
    expect(
      parseAgentDecision({
        type: "action",
        action: {
          type: "click",
          selector: "#go",
          postcondition: { kind: "text", selector: "#status", includes: "Done" },
        },
      }),
    ).toEqual({
      type: "action",
      action: {
        type: "click",
        selector: "#go",
        postcondition: { kind: "text", selector: "#status", includes: "Done" },
      },
    });
  });

  it("parses an explicit URL postcondition", () => {
    expect(
      parseAgentDecision({
        type: "action",
        action: {
          type: "select",
          selector: "#route",
          value: "next",
          postcondition: { kind: "url", equals: "https://example.com/next" },
        },
      }),
    ).toEqual({
      type: "action",
      action: {
        type: "select",
        selector: "#route",
        value: "next",
        postcondition: { kind: "url", equals: "https://example.com/next" },
      },
    });
  });

  it("returns deterministic decisions in order without an API call", async () => {
    const provider = new DeterministicProvider([
      { type: "action", action: { type: "text", selector: "h1" } },
      { type: "finish", output: "ok" },
    ]);
    const input = { goal: "Read title", observation, history: [] };
    expect(await provider.nextAction(input)).toMatchObject({ type: "action" });
    expect(await provider.nextAction(input)).toEqual({ type: "finish", output: "ok" });
    await expect(provider.nextAction(input)).rejects.toThrow(/no remaining decisions/);
  });

  it("uses a configurable OpenAI-compatible endpoint and validates JSON output", async () => {
    let capturedUrl = "";
    let capturedAuthorization = "";
    const fetchMock: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "action",
                  action: { type: "text", selector: "h1" },
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "http://127.0.0.1:7777/v1",
      fetch: fetchMock,
    });
    const decision = await provider.nextAction({ goal: "Read title", observation, history: [] });
    expect(decision).toEqual({ type: "action", action: { type: "text", selector: "h1" } });
    expect(capturedUrl).toBe("http://127.0.0.1:7777/v1/chat/completions");
    expect(capturedAuthorization).toBe("Bearer test-key");
  });

  it("rejects insecure non-local model endpoints", () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          apiKey: "key",
          model: "model",
          baseUrl: "http://example.com/v1",
        }),
    ).toThrow(/HTTPS/);
  });
});
