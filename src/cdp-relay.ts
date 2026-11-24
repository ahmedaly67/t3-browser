// A browser-level CDP endpoint backed by chrome.debugger, so CDP clients such as
// `agent-browser connect` (or Playwright's connectOverCDP) can drive the user's real Chrome.
//
// chrome.debugger only attaches to individual tabs, so the browser-level Target domain is
// emulated here and scoped to one agent thread's tab group. Everything sent on a page
// session is forwarded verbatim to that tab.

import type { WebSocket } from "ws";
import type { EventMessage, ResponseMessage, SessionInfo, TabInfo } from "./protocol.js";

interface Caller {
  call(session: SessionInfo, method: string, params?: Record<string, unknown>): Promise<ResponseMessage>;
}

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, any>;
  sessionId?: string;
}

interface Route {
  tabId: number;
  /** Chrome's own child session (iframes, workers) when the client attached through a page. */
  childSessionId?: string;
}

// Target ids. Clients such as Playwright assume a page's targetId equals its main frame id (true in
// Chrome), so the relay reports Chrome's real id, read from Page.getFrameTree. The synthetic
// `t3tab-<tabId>` form is only a fallback when the real id cannot be read.
const fallbackTargetId = (tabId: number) => `t3tab-${tabId}`;
const realTargetIds = new Map<number, string>();
const tabsByTargetId = new Map<string, number>();
const targetIdFor = (tabId: number) => realTargetIds.get(tabId) ?? fallbackTargetId(tabId);
const tabIdFor = (targetId: string) => {
  const known = tabsByTargetId.get(targetId);
  if (known !== undefined) return known;
  const m = /^t3tab-(\d+)$/.exec(targetId);
  return m ? Number(m[1]) : undefined;
};

export class CdpRelay {
  private discover = false;
  private autoAttach = false;
  /** CDP sessionId -> route. Page sessions are ours; child sessions are Chrome's. */
  private sessions = new Map<string, Route>();
  private pageSession = new Map<number, string>();
  private knownTabs = new Map<number, TabInfo>();
  private seq = 0;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly session: SessionInfo,
    private readonly daemon: Caller,
    private readonly log: (...a: unknown[]) => void,
  ) {
    ws.on("message", (raw) => {
      let msg: CdpRequest;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      this.handle(msg).catch((err) => this.reply(msg, undefined, String(err?.message ?? err)));
    });
  }

  dispose(): void {
    this.closed = true;
    for (const tabId of this.pageSession.keys()) void this.daemon.call(this.session, "cdp.detach", { tabId });
  }

  onExtensionGone(): void {
    this.ws.close(1011, "Chrome extension disconnected");
  }

  private send(obj: unknown): void {
    if (!this.closed && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  private reply(req: CdpRequest, result?: unknown, error?: string): void {
    const base: Record<string, unknown> = { id: req.id };
    if (req.sessionId) base.sessionId = req.sessionId;
    if (error !== undefined) this.send({ ...base, error: { code: -32000, message: error } });
    else this.send({ ...base, result: result ?? {} });
  }

  private emit(method: string, params: unknown, sessionId?: string): void {
    this.send(sessionId ? { method, params, sessionId } : { method, params });
  }

  private async ext<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.daemon.call(this.session, method, params);
    if (res.error) throw new Error(res.error.message);
    return res.result as T;
  }

  private async refreshTabs(): Promise<TabInfo[]> {
    const tabs = await this.ext<TabInfo[]>("tabs.list", { scope: "session" });
    this.knownTabs = new Map(tabs.map((t) => [t.tabId, t]));
    await Promise.all(tabs.map((t) => this.resolveTargetId(t.tabId)));
    return tabs;
  }

  /** Some tab of this thread, attached, for browser-level calls that need a page (cookies). */
  private async anyTab(): Promise<number | undefined> {
    const attached = this.pageSession.keys().next();
    if (!attached.done) return attached.value;
    const [first] = await this.refreshTabs();
    if (!first) return undefined;
    await this.ext("cdp.attach", { tabId: first.tabId });
    return first.tabId;
  }

  /** Learn Chrome's real targetId for a tab (= its main frame id). Cached; falls back to t3tab-<id>. */
  private async resolveTargetId(tabId: number): Promise<string> {
    const cached = realTargetIds.get(tabId);
    if (cached) return cached;
    try {
      await this.ext("cdp.attach", { tabId });
      const r = await this.ext<{ frameTree?: { frame?: { id?: string } } }>("cdp.send", { tabId, method: "Page.getFrameTree", params: {} });
      const id = r?.frameTree?.frame?.id;
      if (id) {
        realTargetIds.set(tabId, id);
        tabsByTargetId.set(id, tabId);
        return id;
      }
    } catch (e) {
      this.log("cdp relay: could not read target id for tab", tabId, String(e));
    }
    return fallbackTargetId(tabId);
  }

  private targetInfo(tab: TabInfo) {
    return {
      targetId: targetIdFor(tab.tabId),
      type: "page",
      title: tab.title,
      url: tab.url,
      attached: this.pageSession.has(tab.tabId),
      canAccessOpener: false,
      browserContextId: "t3-default",
    };
  }

  private attaching = new Map<number, Promise<string>>();

  /** De-duplicated: createTarget and the tab.created event can both ask for the same new tab. */
  private attachTab(tabId: number): Promise<string> {
    const existing = this.pageSession.get(tabId);
    if (existing) return Promise.resolve(existing);
    let pending = this.attaching.get(tabId);
    if (!pending) {
      pending = this.doAttachTab(tabId).finally(() => this.attaching.delete(tabId));
      this.attaching.set(tabId, pending);
    }
    return pending;
  }

  private async doAttachTab(tabId: number): Promise<string> {
    await this.ext("cdp.attach", { tabId });
    await this.resolveTargetId(tabId);
    const sessionId = `t3s-${tabId}-${++this.seq}`;
    this.sessions.set(sessionId, { tabId });
    this.pageSession.set(tabId, sessionId);
    const tab = this.knownTabs.get(tabId) ?? (await this.refreshTabs()).find((t) => t.tabId === tabId);
    this.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: tab ? { ...this.targetInfo(tab), attached: true } : { targetId: targetIdFor(tabId), type: "page", title: "", url: "", attached: true },
      waitingForDebugger: false,
    });
    return sessionId;
  }

  private detachTab(tabId: number, reason?: string): void {
    const sessionId = this.pageSession.get(tabId);
    if (!sessionId) return;
    this.pageSession.delete(tabId);
    for (const [sid, r] of this.sessions) if (r.tabId === tabId) this.sessions.delete(sid);
    this.emit("Target.detachedFromTarget", { sessionId, targetId: targetIdFor(tabId), reason });
  }

  private async handle(req: CdpRequest): Promise<void> {
    if (req.sessionId) {
      const route = this.sessions.get(req.sessionId);
      if (!route) return this.reply(req, undefined, `No session with given id ${req.sessionId}`);
      const result = await this.ext("cdp.send", {
        tabId: route.tabId,
        method: req.method,
        params: req.params ?? {},
        childSessionId: route.childSessionId,
      });
      return this.reply(req, result);
    }

    const p = req.params ?? {};
    switch (req.method) {
      case "Browser.getVersion": {
        const status = await this.ext<{ userAgent?: string }>("status");
        const ua = status.userAgent ?? "";
        const product = /Chrome\/[\d.]+/.exec(ua)?.[0] ?? "Chrome";
        return this.reply(req, { protocolVersion: "1.3", product, revision: "", userAgent: ua, jsVersion: "" });
      }
      case "Target.setDiscoverTargets": {
        this.discover = !!p.discover;
        if (this.discover) for (const t of await this.refreshTabs()) this.emit("Target.targetCreated", { targetInfo: this.targetInfo(t) });
        return this.reply(req, {});
      }
      case "Target.getTargets":
        return this.reply(req, { targetInfos: (await this.refreshTabs()).map((t) => this.targetInfo(t)) });
      case "Target.getTargetInfo": {
        const tabId = p.targetId ? tabIdFor(p.targetId) : undefined;
        if (tabId === undefined) {
          return this.reply(req, { targetInfo: { targetId: "t3-browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } });
        }
        const tab = (await this.refreshTabs()).find((t) => t.tabId === tabId);
        return tab ? this.reply(req, { targetInfo: this.targetInfo(tab) }) : this.reply(req, undefined, "No target with given id found");
      }
      case "Target.attachToTarget": {
        const tabId = tabIdFor(String(p.targetId));
        if (tabId === undefined) return this.reply(req, undefined, "No target with given id found");
        return this.reply(req, { sessionId: await this.attachTab(tabId) });
      }
      case "Target.detachFromTarget": {
        const route = p.sessionId ? this.sessions.get(p.sessionId) : undefined;
        if (route && !route.childSessionId) this.detachTab(route.tabId);
        return this.reply(req, {});
      }
      case "Target.setAutoAttach": {
        this.autoAttach = !!p.autoAttach;
        // Like Chrome: announce existing targets before answering, so clients (Playwright) see them.
        if (this.autoAttach) for (const t of await this.refreshTabs()) await this.attachTab(t.tabId).catch((e) => this.log("auto-attach failed", String(e)));
        return this.reply(req, {});
      }
      case "Target.createTarget": {
        const tab = await this.ext<TabInfo>("tabs.open", { url: p.url || "about:blank", active: p.background === false });
        this.knownTabs.set(tab.tabId, tab);
        await this.resolveTargetId(tab.tabId);
        // Like Chrome: targetCreated/attachedToTarget arrive before the createTarget response
        // (Playwright's newPage() looks the page up as soon as the response lands).
        if (this.discover) this.emit("Target.targetCreated", { targetInfo: this.targetInfo(tab) });
        if (this.autoAttach) await this.attachTab(tab.tabId);
        return this.reply(req, { targetId: targetIdFor(tab.tabId) });
      }
      case "Target.closeTarget": {
        const tabId = tabIdFor(String(p.targetId));
        if (tabId === undefined) return this.reply(req, undefined, "No target with given id found");
        await this.ext("tabs.close", { tabId });
        return this.reply(req, { success: true });
      }
      case "Target.activateTarget":
        return this.reply(req, {});
      case "Target.getBrowserContexts":
        return this.reply(req, { browserContextIds: [] });
      case "Target.createBrowserContext":
      case "Target.disposeBrowserContext":
        return this.reply(req, undefined, "Separate browser contexts are not available in the user's browser. Use the isolated browser for that.");
      case "Browser.getWindowForTarget":
        return this.reply(req, { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" } });
      case "Browser.close":
        // Never close the user's own browser on behalf of an automation client.
        return this.reply(req, {});
      // Cookies (Playwright's page.request / context.cookies() use these on the browser session).
      // chrome.debugger has no browser session, so they go through one of this thread's tabs.
      case "Storage.getCookies": {
        const tabId = await this.anyTab();
        if (tabId === undefined) return this.reply(req, { cookies: [] });
        const r = await this.ext<{ cookies?: unknown[] }>("cdp.send", { tabId, method: "Network.getAllCookies", params: {} })
          .catch(() => this.ext<{ cookies?: unknown[] }>("cdp.send", { tabId, method: "Storage.getCookies", params: {} }));
        return this.reply(req, { cookies: r?.cookies ?? [] });
      }
      case "Storage.setCookies": {
        const tabId = await this.anyTab();
        if (tabId !== undefined && Array.isArray(p.cookies) && p.cookies.length)
          await this.ext("cdp.send", { tabId, method: "Network.setCookies", params: { cookies: p.cookies } });
        return this.reply(req, {});
      }
      case "Storage.clearCookies":
        // Never wipe the user's sign-ins on behalf of an automation client.
        this.log("cdp relay: refused Storage.clearCookies");
        return this.reply(req, {});
      default:
        this.log("cdp relay: no-op browser method", req.method);
        return this.reply(req, {});
    }
  }

  onEvent(msg: EventMessage): void {
    if (msg.sessionId !== this.session.id) return;
    const data = (msg.data ?? {}) as Record<string, any>;
    switch (msg.event) {
      case "cdp": {
        const page = this.pageSession.get(data.tabId);
        if (!page) return;
        // Track Chrome's child sessions (OOPIFs, workers) so the client can talk to them.
        if (data.method === "Target.attachedToTarget" && data.params?.sessionId) {
          this.sessions.set(data.params.sessionId, { tabId: data.tabId, childSessionId: data.params.sessionId });
        } else if (data.method === "Target.detachedFromTarget" && data.params?.sessionId) {
          this.sessions.delete(data.params.sessionId);
        }
        this.emit(data.method, data.params, data.childSessionId ?? page);
        return;
      }
      case "tab.created":
        void (async () => {
          const tab = (await this.refreshTabs()).find((t) => t.tabId === data.tabId);
          if (!tab) return;
          if (this.discover) this.emit("Target.targetCreated", { targetInfo: this.targetInfo(tab) });
          if (this.autoAttach) await this.attachTab(tab.tabId).catch(() => {});
        })();
        return;
      case "tab.removed":
        this.detachTab(data.tabId, "target_closed");
        this.knownTabs.delete(data.tabId);
        if (this.discover) this.emit("Target.targetDestroyed", { targetId: targetIdFor(data.tabId) });
        { const id = realTargetIds.get(data.tabId); if (id) tabsByTargetId.delete(id); realTargetIds.delete(data.tabId); }
        return;
      case "cdp.detached":
        this.detachTab(data.tabId, data.reason);
        return;
      case "interrupted":
        for (const tabId of [...this.pageSession.keys()]) this.detachTab(tabId, "interrupted_by_user");
        return;
    }
  }
}
