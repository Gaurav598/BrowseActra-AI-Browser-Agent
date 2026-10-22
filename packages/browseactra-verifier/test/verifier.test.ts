import { describe, expect, it } from "vitest";
import { checkCondition, createReceipt, redactObservation } from "../src/index.js";

describe("action verification", () => {
  it("verifies observed navigation", () => {
    const receipt = createReceipt({
      action: "navigate",
      before: { url: "about:blank" },
      after: { url: "https://example.com/" },
      postcondition: { kind: "url", equals: "https://example.com/" },
    });
    expect(receipt.status).toBe("verified");
  });

  it("rejects a failed precondition", () => {
    const receipt = createReceipt({
      action: "click",
      before: { url: "https://example.com/" },
      precondition: { kind: "url", equals: "https://other.example/" },
      after: { url: "https://example.com/" },
    });
    expect(receipt.status).toBe("rejected");
  });

  it("never reports success for an ambiguous side effect", () => {
    const receipt = createReceipt({
      action: "submit",
      before: { url: "https://example.com/" },
      executionError: new Error("disconnected"),
    });
    expect(receipt.status).toBe("indeterminate");
  });

  it("redacts sensitive evidence", () => {
    const observation = redactObservation({
      url: "https://example.com/",
      text: "token=supersecret",
      fields: { password: "hunter2", name: "Alice" },
    });
    expect(observation.text).toBe("[REDACTED]");
    expect(observation.fields).toEqual({ password: "[REDACTED]", name: "Alice" });
  });

  it("returns indeterminate when evidence is missing", () => {
    expect(
      checkCondition({ url: "about:blank" }, { kind: "text", includes: "done" }),
    ).toBeUndefined();
  });
});
