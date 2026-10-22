import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserObservation, BrowserSession } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_VISIBLE_TEXT = 4_000;
const MAX_INSPECTION_JSON = 16_000;
// Playwright serializes this expression directly. Transpilers such as tsx can
// otherwise insert out-of-scope helpers (for example __name) into callbacks.
const OBSERVATION_SCRIPT = `(() => {
  const bounded = (value, size) => (value ?? "").trim().slice(0, size);
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const name = element.getAttribute("name");
    if (name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    const parent = element.parentElement;
    if (!parent) return element.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    return element.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(element) + 1) + ")";
  };
  const text = bounded(document.body?.innerText, ${MAX_VISIBLE_TEXT});
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 20)
    .map((link) => ({ text: bounded(link.innerText, 80), href: bounded(link.href, 200) }));
  const controls = Array.from(document.querySelectorAll("button, a[href], [role=button]"))
    .slice(0, 30)
    .map((element) => ({
      selector: selectorFor(element),
      label: bounded(element.textContent, 80),
      role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
    }));
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .slice(0, 20)
    .map((element) => ({
      selector: selectorFor(element),
      label: bounded(element.getAttribute("aria-label") ?? element.getAttribute("placeholder"), 80),
      type: element.getAttribute("type") ?? element.tagName.toLowerCase(),
    }));
  return { title: bounded(document.title, 160), text, links, controls, fields };
})()`;

export interface BrowserFactoryOptions {
  readonly allowedDomains?: readonly string[];
  readonly headless?: boolean;
  readonly timeoutMs?: number;
  readonly executablePath?: string;
  readonly channel?: "chrome" | "chromium";
  readonly signal?: AbortSignal;
}

export interface BrowserConnectOptions extends Omit<
  BrowserFactoryOptions,
  "headless" | "executablePath"
> {
  /** A trusted local Chrome DevTools endpoint. */
  readonly endpoint: string;
}

/**
 * Playwright is used as a third-party browser driver. This session and its
 * lifecycle, observation, and target-policy contracts are BrowseActra code.
 */
export class BrowserFactory {
  static async open(options: BrowserFactoryOptions = {}): Promise<BrowserSession> {
    validateOptions(options);
    throwIfAborted(options.signal);
    const browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(options.channel ? { channel: options.channel } : {}),
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return createSession(browser, options);
  }

  static async connect(options: BrowserConnectOptions): Promise<BrowserSession> {
    validateOptions(options);
    assertLocalCdpEndpoint(options.endpoint);
    throwIfAborted(options.signal);
    const browser = await chromium.connectOverCDP(options.endpoint, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return createSession(browser, options);
  }
}

async function createSession(
  browser: Browser,
  options: BrowserFactoryOptions,
): Promise<BrowserSession> {
  try {
    throwIfAborted(options.signal);
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const allowedDomains = normalizeAllowedDomains(options.allowedDomains);
    await context.route("**/*", async (route) => {
      try {
        assertAllowedUrl(route.request().url(), allowedDomains);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    await context.routeWebSocket("**/*", async (route) => {
      try {
        const url = new URL(route.url());
        if (url.protocol !== "ws:" && url.protocol !== "wss:")
          throw new Error("Invalid WebSocket target");
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        assertAllowedUrl(url.href, allowedDomains);
        route.connectToServer();
      } catch {
        await route.close({ code: 1008, reason: "Browser target blocked" }).catch(() => {});
      }
    });
    const page = await context.newPage();
    const session = new PlaywrightSession(
      browser,
      context,
      page,
      allowedDomains,
      options.timeoutMs,
    );
    if (options.signal) {
      if (options.signal.aborted) {
        await session.close();
        throw options.signal.reason ?? new Error("Browser launch cancelled");
      }
      session.attachAbortSignal(options.signal);
    }
    return session;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

class PlaywrightSession implements BrowserSession {
  readonly id = randomUUID();
  private closePromise: Promise<void> | undefined;
  private readonly timeoutMs: number;
  private abortSignal: AbortSignal | undefined;
  private abortHandler: (() => void) | undefined;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly allowedDomains: readonly string[],
    timeoutMs: number | undefined,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    page.setDefaultTimeout(this.timeoutMs);
    page.setDefaultNavigationTimeout(this.timeoutMs);
  }

  async navigate(url: string): Promise<void> {
    this.assertOpen();
    assertAllowedUrl(url, this.allowedDomains);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
  }

  async click(selector: string): Promise<void> {
    this.assertOpen();
    await this.page.locator(selector).click({ timeout: this.timeoutMs });
  }

  async fill(selector: string, value: string): Promise<void> {
    this.assertOpen();
    await this.page.locator(selector).fill(value, { timeout: this.timeoutMs });
  }

  async select(selector: string, value: string): Promise<void> {
    this.assertOpen();
    await this.page.locator(selector).selectOption(value, { timeout: this.timeoutMs });
  }

  async text(selector: string): Promise<string> {
    this.assertOpen();
    return (await this.page.locator(selector).innerText({ timeout: this.timeoutMs })).slice(
      0,
      MAX_VISIBLE_TEXT,
    );
  }

  async observe(): Promise<BrowserObservation> {
    this.assertOpen();
    const snapshot = (await this.page.evaluate(OBSERVATION_SCRIPT)) as Omit<
      BrowserObservation,
      "url"
    >;
    return { url: this.page.url(), ...snapshot };
  }

  async inspect(): Promise<string> {
    const observation = await this.observe();
    const json = JSON.stringify(observation);
    if (json.length <= MAX_INSPECTION_JSON) return json;
    return JSON.stringify({
      ...observation,
      text: observation.text.slice(0, 1_000),
      links: [],
      controls: [],
      fields: [],
    });
  }

  async url(): Promise<string> {
    this.assertOpen();
    return this.page.url();
  }

  close(): Promise<void> {
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
      this.abortSignal = undefined;
      this.abortHandler = undefined;
    }
    this.closePromise ??= (async () => {
      await this.context.close().catch(() => {});
      await this.browser.close().catch(() => {});
    })();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closePromise) throw new Error("Browser session is closed");
  }

  attachAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
    this.abortHandler = () => {
      void this.close();
    };
    signal.addEventListener("abort", this.abortHandler, { once: true });
  }
}

export function assertAllowedUrl(rawUrl: string, allowedDomains: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid browser target URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Browser target must be an HTTP(S) URL without embedded credentials");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (allowedDomains.length > 0) {
    if (!allowedDomains.includes(host))
      throw new Error(`Browser target is outside allowed domains: ${host}`);
  } else if (isPrivateTarget(host)) {
    throw new Error(`Browser target requires an explicit domain allowlist: ${host}`);
  }
  return url;
}

function normalizeAllowedDomains(domains: readonly string[] | undefined): readonly string[] {
  return (domains ?? []).map((domain) => {
    const normalized = domain.toLowerCase().replace(/\.$/, "");
    if (
      !/^[a-z0-9][a-z0-9.:-]*$/.test(normalized) ||
      normalized.includes("/") ||
      normalized.includes("@")
    ) {
      throw new Error(`Invalid allowed domain: ${domain}`);
    }
    return normalized;
  });
}

function isPrivateTarget(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  // WHATWG URLs retain brackets around IPv6 hostnames; net.isIP does not.
  if (isIP(host.replace(/^\[|\]$/g, "")) === 6) return true;
  if (isIP(host) !== 4) return false;
  const octets = host.split(".").map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function assertLocalCdpEndpoint(raw: string): void {
  const url = new URL(raw);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "CDP endpoint must be a local HTTP(S) or WebSocket URL without embedded credentials",
    );
  }
}

function validateOptions(options: BrowserFactoryOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
  ) {
    throw new Error("timeoutMs must be between 1 and 120000");
  }
  normalizeAllowedDomains(options.allowedDomains);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Browser operation cancelled");
}
