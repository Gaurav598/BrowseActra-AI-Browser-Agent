import { describe, expect, it } from "vitest";
import { assertAllowedUrl } from "../src/browser.js";

describe("browser target policy", () => {
  it("accepts public HTTPS targets and strips no destination information", () => {
    expect(assertAllowedUrl("https://example.com/catalog?q=book").href).toBe(
      "https://example.com/catalog?q=book",
    );
  });

  it.each([
    "file:///etc/passwd",
    "data:text/html,hello",
    "http://127.0.0.1:8080/",
    "http://[::1]:8080/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.20/",
    "https://user:pass@example.com/",
  ])("rejects unsafe target %s by default", (url) => {
    expect(() => assertAllowedUrl(url)).toThrow();
  });

  it("permits an explicitly allowed local fixture and rejects unrelated hosts", () => {
    expect(assertAllowedUrl("http://127.0.0.1:3456/", ["127.0.0.1"]).hostname).toBe("127.0.0.1");
    expect(() => assertAllowedUrl("https://other.example/", ["example.com"])).toThrow(
      /outside allowed domains/,
    );
  });
});
