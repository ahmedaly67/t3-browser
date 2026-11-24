// browser_run_code: run a Playwright script (`async (page) => { ... }`) against this thread's tabs in
// the user's real Chrome, through the thread's CDP relay. A drop-in for Playwright MCP's
// browser_run_code_unsafe, so batch scripts written for it keep working unchanged.
//
// The connection and the default page persist across calls (like Playwright MCP), so a script
// can continue in the tab a previous call left behind. Scripts are trusted local code: they run
// in this MCP process with full Node access, exactly like browser_run_code_unsafe.

import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";

export class CodeRunner {
  private browser: Browser | undefined;
  private page: Page | undefined;

  constructor(private readonly cdpUrl: () => Promise<string>) {}

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const { chromium } = await import("playwright-core");
    this.browser = await chromium.connectOverCDP(await this.cdpUrl(), { timeout: 30_000 });
    this.browser.on("disconnected", () => {
      this.browser = undefined;
      this.page = undefined;
    });
    return this.browser;
  }

  /** The page handed to scripts: kept between calls, recreated in this thread's group if closed. */
  private async defaultPage(): Promise<Page> {
    const browser = await this.connect();
    if (this.page && !this.page.isClosed()) return this.page;
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context from the relay. Is the T3 Browser extension connected?");
    this.page = await context.newPage();
    return this.page;
  }

  async run(opts: { code?: string; filename?: string; timeoutMs?: number }): Promise<unknown> {
    const source = opts.filename ? readFileSync(opts.filename, "utf8") : opts.code;
    if (!source?.trim()) throw new Error("Pass code or filename: a function like `async (page) => { ... }`.");
    // Indirect eval: the file is a single function expression, as with browser_run_code_unsafe.
    const fn = (0, eval)(`(${source.trim().replace(/;\s*$/, "")})`);
    if (typeof fn !== "function") throw new Error("The code must evaluate to a function: `async (page) => { ... }`.");
    const page = await this.defaultPage();
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30 * 60_000, 1_000), 2 * 60 * 60_000);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve(fn(page)),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs} ms`)), timeoutMs))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // Only drops the CDP connection; the relay never closes the user's browser.
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }
}
