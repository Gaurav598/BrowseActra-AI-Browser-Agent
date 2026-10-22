import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BrowserFactory } from "../src/browser.js";

const integration = process.env.BROWSEACTRA_BROWSER_TEST === "1" ? describe : describe.skip;

integration("Playwright browser session", () => {
  it("navigates, observes, fills, clicks, and closes an isolated local page", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Fixture</title>
        <label for="name">Name</label><input id="name">
        <select id="choice" onchange="document.querySelector('#status').textContent = 'Selected ' + this.value">
          <option value="one">One</option><option value="two">Two</option>
        </select>
        <button id="go" onclick="document.querySelector('#status').textContent =
          'Hello ' + document.querySelector('#name').value">Go</button>
        <p id="status">Ready</p>`);
    });
    let session: Awaited<ReturnType<typeof BrowserFactory.open>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/`;
      session = await BrowserFactory.open({
        allowedDomains: ["127.0.0.1"],
        channel: process.env.BROWSEACTRA_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
      });
      expect((await session.observe()).url).toBe("about:blank");
      await session.navigate(url);
      expect(await session.url()).toBe(url);
      expect((await session.observe()).controls.some((control) => control.selector === "#go")).toBe(
        true,
      );
      await session.fill("#name", "Ada");
      await session.select("#choice", "two");
      expect(await session.text("#status")).toBe("Selected two");
      await session.click("#go");
      expect(await session.text("#status")).toBe("Hello Ada");
      expect((await session.inspect()).length).toBeLessThanOrEqual(16_000);
    } finally {
      await session?.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    await expect(session?.observe()).rejects.toThrow(/closed/);
  });
});
