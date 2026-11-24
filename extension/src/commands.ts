// Implementation of every method the daemon can call. Each handler receives the calling
// thread's Session and validated-ish params, and returns JSON (screenshots as base64).

import type { ResponseMessage, SessionInfo, TabInfo } from "../../src/protocol";
import { attach, busyCount, detach, detachIdle, isAttached, markBusy, onCdpEvent, onDocumentReplaced, send } from "./cdp";
import { parseKey } from "./keys";
import {
  ActionError,
  addTab,
  assertOwnsTab,
  assertUsableTab,
  assertWebUrl,
  clearHandback,
  dropSession,
  handedBack,
  getSession,
  persist,
  placeForNewTab,
  renameSession,
  sessionForTab,
  setHandback,
  takeInterrupt,
  threadColorHex,
  threadInk,
  unmarkTab,
  type Session,
} from "./sessions";
import { handbackMessage, NOTE_MAX } from "./handback";
import { threadGroupTitle } from "./identity";
import { createQueue } from "./serial";
import { formatAXTree, RefAllocator, type AXNode } from "./snapshot";
import { isWebUrl, normalizeUrl, notWebPageMessage } from "./urls";

type Params = Record<string, any>;

// ---------------------------------------------------------------------------------------
// Per-tab runtime state (refs, dialogs). Lost on service-worker restart; refs then simply
// need a fresh snapshot, which the error message says.

const refAllocators = new Map<number, RefAllocator>();
const dialogs = new Map<number, { type: string; message: string; defaultPrompt?: string; url?: string }>();

export function refsFor(tabId: number): RefAllocator {
  let r = refAllocators.get(tabId);
  if (!r) refAllocators.set(tabId, (r = new RefAllocator()));
  return r;
}

export function onTabNavigated(tabId: number): void {
  refAllocators.get(tabId)?.reset();
}
onDocumentReplaced(onTabNavigated);

const dialogWaiters = new Map<number, Set<() => void>>();

export function onDialog(tabId: number, opening: boolean, params?: any): void {
  if (opening) {
    dialogs.set(tabId, { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url });
    const waiters = dialogWaiters.get(tabId);
    dialogWaiters.delete(tabId);
    waiters?.forEach((w) => w());
  } else dialogs.delete(tabId);
}

/**
 * Input that opens alert()/confirm() blocks its CDP call until the dialog closes. Resolve as
 * soon as a dialog appears instead, so the agent sees it and can answer with browser_dialog.
 */
async function unlessDialog<T>(tabId: number, work: Promise<T>): Promise<T | undefined> {
  let remove = () => {};
  const opened = new Promise<undefined>((resolve) => {
    const set = dialogWaiters.get(tabId) ?? new Set();
    const w = () => resolve(undefined);
    set.add(w);
    dialogWaiters.set(tabId, set);
    remove = () => set.delete(w);
  });
  work.catch(() => {}); // a late rejection after the dialog won the race is not an error
  try {
    return await Promise.race([work, opened]);
  } finally {
    remove();
  }
}

export function forgetTab(tabId: number): void {
  refAllocators.delete(tabId);
  pointers.delete(tabId);
  dialogs.delete(tabId);
}

// ---------------------------------------------------------------------------------------
// Helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settle with `work`, or reject after `ms`: no Chrome API call may hang a command. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {}); // a late rejection after the deadline is not an error
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ActionError(`${what} did not finish within ${ms / 1000}s.`, "timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}


function tabInfo(tab: chrome.tabs.Tab, s?: Session): TabInfo {
  return {
    tabId: tab.id!,
    url: tab.pendingUrl || tab.url || "",
    title: tab.title ?? "",
    active: !!tab.active,
    status: tab.status,
    inSession: !!s && s.tabIds.includes(tab.id!),
    windowId: tab.windowId,
  };
}

async function waitForLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  // Give a click a moment to start a navigation before deciding nothing happened.
  await sleep(150);
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new ActionError("The tab was closed.", "tab_closed");
    if (tab.status === "complete") return;
    await sleep(150);
  }
}

type OverlayFn = "show" | "hide" | "moveTo" | "click" | "activity" | "agentActing" | "yourTurn" | "handedBack";

async function overlay(tabId: number, fn: OverlayFn, ...args: unknown[]): Promise<void> {
  // Chrome runs extension scripts in hidden tabs (background tabs, or the whole window covered
  // by another app) very slowly: 1.5-3s per call measured in Chrome 157, on every agent action.
  // So in hidden tabs nothing here makes the agent wait; syncOverlay() puts the cursor where it
  // belongs when the tab comes into view.
  const visible = await maybeVisible(tabId);
  // The user's turn (and its "sent" confirmation) must reach the page even in a hidden tab.
  const always = fn === "show" || fn === "yourTurn" || fn === "handedBack";
  if (fn === "hide" || (always && !visible)) {
    // Never wait for these in a hidden tab, but always do them: "show" puts the Esc listener in
    // place (the user may look at the tab without any event telling us), "hide" removes a
    // stale overlay. The overlay itself ignores Escape and lets clicks through while hidden.
    void withDeadline(overlayNow(tabId, fn, args), 3_000, "Updating the overlay").catch(() => {});
    return;
  }
  // The cursor, its tag and the click ripple only matter to someone watching.
  if (!visible) return;
  // executeScript waits for the document to become idle, which a slow page (a dev server
  // compiling its first request) may not reach for a long time. The overlay is shown again
  // when the page finishes loading, so give up quickly here.
  await withDeadline(overlayNow(tabId, fn, args), 3_000, "Showing the overlay").catch(() => {});
}

/** Can the user see this tab? Asks the page when we are attached (fast), else Chrome. */
async function maybeVisible(tabId: number): Promise<boolean> {
  if (isAttached(tabId)) return pageVisible(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.active) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
  return win?.state !== "minimized";
}

/**
 * The tab came into view (the user switched to it, or brought the window back): show the
 * overlay as it should be and put the cursor where the agent last acted.
 */
export async function syncOverlay(tabId: number, s: Session): Promise<void> {
  if (s.handback?.tabId === tabId) return showYourTurn(tabId, s);
  if (!overlayShown.has(tabId) || s.interrupted) return;
  await showOverlay(tabId, s);
  const at = pointers.get(tabId);
  if (at) await overlay(tabId, "moveTo", at.x, at.y, at, null);
}

async function overlayNow(tabId: number, fn: string, args: unknown[]): Promise<void> {
  try {
    if (fn === "show" || fn === "yourTurn") {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (f: string, a: unknown[]) => {
        const o = (window as any).__t3BrowserOverlay;
        // moveTo returns a promise; executeScript waits for it, so the glide finishes first.
        if (o && typeof o[f] === "function") return o[f](...a);
      },
      args: [fn, args],
    });
  } catch {
    // Overlays are cosmetic; restricted pages and mid-navigation documents just skip them.
  }
}

// ---- The agent's visible cursor ------------------------------------------------------------
// Where the cursor last was in each tab, so after a navigation it continues from there.
const pointers = new Map<number, { x: number; y: number }>();

/** Glide the agent cursor to (x, y) and wait until it arrives (instant in background tabs). */
async function glideTo(tabId: number, x: number, y: number, activity: string | null = null): Promise<void> {
  const from = pointers.get(tabId) ?? null;
  pointers.set(tabId, { x, y });
  await overlay(tabId, "moveTo", x, y, from, activity);
}

/** The element's on-screen centre, without hit-testing (for typing and selecting). */
async function centerOf(tabId: number, backendNodeId: number): Promise<{ x: number; y: number } | undefined> {
  try {
    const { quads } = await send<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId });
    const q = quads?.[0];
    if (!q) return undefined;
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  } catch {
    return undefined;
  }
}

/** Tabs where the overlay is (meant to be) showing. */
const overlayShown = new Set<number>();

export async function showOverlay(tabId: number, s: Session): Promise<void> {
  overlayShown.add(tabId);
  await overlay(tabId, "show", overlayLabel(s), !!s.link, threadColorHex(s), s.num ? `T3 #${s.num}` : "T3 Code", threadInk(s));
}

/**
 * The user has the tab (Esc, Stop, or the agent handed it over): no frame or cursor, just a card
 * with what the agent asked for, a note box and Hand back, and the link to the thread.
 */
export async function showYourTurn(tabId: number, s: Session): Promise<void> {
  overlayShown.delete(tabId);
  await overlay(tabId, "yourTurn", {
    label: `T3 Code${s.num ? ` #${s.num}` : ""} · ${s.title}`,
    hasLink: !!s.link,
    color: threadColorHex(s),
    ink: threadInk(s),
    ask: s.handback?.ask ?? "",
    // Without a T3 Code thread there is nowhere to post the note.
    canSend: !!s.link,
  });
}

let daemonAsk: ((info: SessionInfo, method: string, params: Record<string, unknown>) => Promise<ResponseMessage>) | undefined;
/** The background registers how to ask the daemon something (through the offscreen socket). */
export function onDaemonAsk(fn: typeof daemonAsk): void {
  daemonAsk = fn;
}

/**
 * Give the tab back to the agent: post the note to its T3 Code thread, then let it carry on
 * (it is not told it was stopped: the note says what to do). Used by the page and the phone.
 */
export async function handBack(s: Session, note: string): Promise<{ sent: true }> {
  const hb = s.handback;
  if (!hb) throw new ActionError("The agent already has this tab back.", "no_handback");
  if (!daemonAsk) throw new ActionError("T3 Browser is not connected to T3 Code.", "no_daemon");
  const tab = await chrome.tabs.get(hb.tabId).catch(() => undefined);
  const message = handbackMessage(hb.tabId, tab?.title, tab?.url, String(note ?? "").slice(0, NOTE_MAX));
  const r = await daemonAsk({ id: s.id, title: s.title, ...(s.link ? { link: s.link } : {}) }, "thread.send", { message });
  if (r.error) throw new ActionError(r.error.message, r.error.code);
  await handedBack(s);
  await overlay(hb.tabId, "handedBack", `Sent to T3 Code${s.num ? ` #${s.num}` : ""}. It takes it from here.`);
  return { sent: true };
}

function overlayLabel(s: Session): string {
  return `T3 Code${s.num ? ` #${s.num}` : ""} is using this tab · ${s.title}`;
}

/** A dialog is open on the tab (keep the debugger attached so its events keep flowing). */
export function hasDialog(tabId: number): boolean {
  return dialogs.has(tabId);
}

let stopHandler: ((s: Session, reason: string) => Promise<void>) | undefined;
/** The background registers how to interrupt a thread (Esc / Stop use the same path). */
export function onStopRequest(fn: (s: Session, reason: string) => Promise<void>): void {
  stopHandler = fn;
}

export async function hideOverlay(tabId: number): Promise<void> {
  overlayShown.delete(tabId);
  await overlay(tabId, "hide");
}

/** Common entry for anything that touches a page: ownership, interrupts, web pages only, debugger. */
async function prepare(s: Session, tabId: number): Promise<chrome.tabs.Tab> {
  await takeInterrupt(s);
  assertOwnsTab(s, tabId);
  // The agent acts in a tab the user had: it took the tab back (the user answered in chat).
  const tookBack = s.handback?.tabId === tabId;
  if (tookBack) await clearHandback(s);
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new ActionError(`Tab ${tabId} no longer exists.`, "tab_closed");
  });
  assertUsableTab(tab);
  const dialog = dialogs.get(tabId);
  if (dialog) {
    throw new ActionError(
      `A ${dialog.type} dialog is open on this tab: ${JSON.stringify(dialog.message)}. Handle it with browser_dialog first.`,
      "dialog_open",
    );
  }
  if (!isAttached(tabId)) {
    await attach(tabId);
    await showOverlay(tabId, s);
  } else if (tookBack) {
    await showOverlay(tabId, s);
  }
  return tab;
}

function resolveRef(tabId: number, ref: string) {
  const key = ref.replace(/^@/, "").replace(/^ref=/, "");
  const target = refsFor(tabId).targets.get(key);
  if (!target) {
    throw new ActionError(`Unknown ref "${ref}". Refs expire when the page changes; take a new browser_snapshot.`, "stale_ref");
  }
  return target;
}

async function objectIdFor(tabId: number, backendNodeId: number): Promise<string> {
  try {
    const { object } = await send(tabId, "DOM.resolveNode", { backendNodeId });
    return object.objectId;
  } catch {
    throw new ActionError("That element is gone from the page. Take a new browser_snapshot.", "stale_ref");
  }
}

async function callOn<T = any>(tabId: number, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
  const res = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new ActionError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result?.value as T;
}

/** Scroll into view, find the element's centre, and verify nothing covers it. */
async function clickablePoint(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
  await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  let quads: number[][] = [];
  try {
    ({ quads } = await send(tabId, "DOM.getContentQuads", { backendNodeId }));
  } catch {
    // fallthrough
  }
  if (!quads?.length) throw new ActionError("That element is not visible (it has no on-screen box).", "not_visible");
  const q = quads[0];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;

  const objectId = await objectIdFor(tabId, backendNodeId);
  const blocker = await callOn<string | null>(
    tabId,
    objectId,
    `function (x, y) {
      if (this.ownerDocument !== document) return null; // inside an iframe: skip hit-testing
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit || hit.tagName === "T3-BROWSER-OVERLAY") return null;
      const self = this.nodeType === 1 ? this : this.parentElement;
      if (!self || self === hit || self.contains(hit) || hit.contains(self)) return null;
      if (self.getRootNode() instanceof ShadowRoot && self.getRootNode().host.contains(hit)) return null;
      if (hit.closest && self.closest && hit.closest("label") && hit.closest("label").control === self) return null;
      const d = hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") +
        (typeof hit.className === "string" && hit.className.trim() ? "." + hit.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
      const text = (hit.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      return d + (text ? ' "' + text + '"' : "");
    }`,
    [x, y],
  );
  if (blocker) {
    throw new ActionError(
      `The element is covered by ${blocker}. Dismiss it (e.g. a cookie banner or modal), take a new snapshot, and retry.`,
      "covered",
    );
  }
  return { x, y };
}

async function mouseClick(tabId: number, x: number, y: number, button = "left", clickCount = 1, activity: string | null = null): Promise<void> {
  // Show the move first, then the click, then send the real input: the user sees what the
  // agent is about to do instead of a jump.
  await glideTo(tabId, x, y, activity);
  await overlay(tabId, "agentActing", 800);
  await overlay(tabId, "click", x, y);
  // In a tab the user can see, move the mouse there first like a person would (hover styles,
  // pointerenter). In a hidden tab Chrome holds mouse moves for 1-5s (they wait for a frame
  // that never comes), while presses and releases go straight through and carry the position.
  if (await pageVisible(tabId)) await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clickCount; i++) {
    await unlessDialog(tabId, send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i }));
    if (dialogs.has(tabId)) return;
    await unlessDialog(tabId, send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i }));
    if (dialogs.has(tabId)) return;
  }
}

async function pressKey(tabId: number, chord: string): Promise<void> {
  const k = parseKey(chord);
  if (k.key === "Escape") await overlay(tabId, "agentActing", 800);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  await unlessDialog(tabId, send(tabId, "Input.dispatchKeyEvent", { ...base, type: k.text ? "keyDown" : "rawKeyDown", text: k.text, unmodifiedText: k.text }));
  if (dialogs.has(tabId)) return;
  await unlessDialog(tabId, send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }));
}

/** Longest the visible typing animation may take, however long the text. */
const TYPING_MAX_MS = 1_500;

/**
 * Type `text` into the focused element. When the user can see the tab, it appears a few
 * characters at a time (like a person typing, quickly); in a background tab nobody is watching,
 * so it goes in at once. Very long text always goes in at once.
 */
async function typeText(tabId: number, s: Session, text: string): Promise<void> {
  const chars = Array.from(text); // code points, so emoji are never split in half
  const visible = await send<{ result: { value?: boolean } }>(tabId, "Runtime.evaluate", { expression: "document.visibilityState === 'visible'", returnByValue: true })
    .then((r) => r.result.value === true)
    .catch(() => false);
  if (!visible || chars.length > 2_000) {
    await unlessDialog(tabId, send(tabId, "Input.insertText", { text }));
    return;
  }
  const steps = Math.min(chars.length, 60);
  const size = Math.ceil(chars.length / steps);
  const pause = Math.min(28, Math.floor(TYPING_MAX_MS / steps));
  for (let i = 0; i < chars.length; i += size) {
    if (s.interrupted) return;
    await unlessDialog(tabId, send(tabId, "Input.insertText", { text: chars.slice(i, i + size).join("") }));
    if (dialogs.has(tabId)) return;
    if (i + size < chars.length) await sleep(pause);
  }
}

async function pageState(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  const dialog = dialogs.get(tabId);
  return { tabId, url: tab.url, title: tab.title, ...(dialog ? { dialog } : {}) };
}

/** Act, then report where we ended up (navigations from clicks are common). */
async function afterAction(tabId: number, before: string | undefined) {
  if (!dialogs.has(tabId)) await waitForLoad(tabId, 10_000).catch(() => {});
  const state = await pageState(tabId);
  return { ...state, navigated: !!before && state.url !== before };
}

/**
 * Chrome does not paint background tabs, so a capture there never completes. Try anyway
 * (it works when the tab is visible, e.g. in its own window), then briefly bring the tab to
 * the front of its window, capture, and put the user's tab back.
 */
async function pageVisible(tabId: number): Promise<boolean> {
  return send<{ result: { value?: boolean } }>(tabId, "Runtime.evaluate", { expression: "document.visibilityState === 'visible'", returnByValue: true }, undefined, 1_000)
    .then((r) => r.result.value === true)
    .catch(() => false);
}

/** One capture at a time: two threads screenshotting at once must not trade the user's tab. */
const oneAtATime = createQueue();

/**
 * Tabs the extension itself is bringing to the front (screenshots), so the popup guard in the
 * background does not mistake that for a popup jumping in front of the user.
 */
export const ownActivations = new Set<number>();

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

/** Hide or show the overlay's element through CDP: instant even in a hidden tab, unlike executeScript. */
async function overlayElementHidden(tabId: number, hidden: boolean): Promise<void> {
  const expression = `document.querySelectorAll("t3-browser-overlay").forEach((e) => ${hidden ? 'e.style.setProperty("visibility", "hidden", "important")' : 'e.style.removeProperty("visibility")'})`;
  await send(tabId, "Runtime.evaluate", { expression }, undefined, 1_000).catch(() => {});
}

/**
 * A screenshot of a background tab without bringing it to the front.
 *
 * Measured in Chrome 157 on Windows: Page.captureScreenshot alone on a hidden tab takes ~2s in
 * Chrome stable and never answers while the window is minimized. With a screencast running on
 * the tab, the same capture answers in ~90ms, minimized too, with the current page. The
 * screencast's own frames are not used: they can show what the tab drew long ago (seen in the
 * user's Chrome: a page from before the agent changed it, with the overlay still on it).
 *
 * Resolves `data` with the capture's answer if it comes in time; `done` once the screencast is
 * cleaned up. Without an answer in time, `data` is undefined and `pending` is still in flight.
 */
async function captureHidden(
  tabId: number,
  params: Record<string, unknown>,
): Promise<{ data?: string; pending: Promise<Settled<string>>; done: Promise<void> }> {
  // A CDP client on the relay (agent-browser) may run its own screencast on this tab: ours would
  // replace and then stop it, and its frames would reach that client. Plain capture there.
  const useScreencast = !relayTabs.has(tabId);
  // Frames must be acknowledged or Chrome stops sending them (and the screencast stops helping).
  const stopListening = useScreencast
    ? onCdpEvent((id, method, p: any, child) => {
        if (id === tabId && !child && method === "Page.screencastFrame") {
          void send(tabId, "Page.screencastFrameAck", { sessionId: p.sessionId }, undefined, 1_000).catch(() => {});
        }
      })
    : () => {};
  // Tiny frames: only the screencast running matters, not what it sends.
  const casting = useScreencast
    ? await send(tabId, "Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 }, undefined, 2_000)
        .then(() => true)
        .catch(() => false)
    : false;
  const pending = settle(send<{ data: string }>(tabId, "Page.captureScreenshot", params, undefined, 15_000).then((r) => r.data));

  const first = await Promise.race([pending, sleep(2_000).then(() => undefined)]);
  const data = first?.ok ? first.value : undefined;

  // Keep the screencast until the capture answers (it may be what lets the capture finish),
  // bounded: a capture Chrome never answers must not hold the screenshot queue for long.
  const done = (async () => {
    await Promise.race([pending, sleep(3_000)]);
    stopListening();
    if (casting) await send(tabId, "Page.stopScreencast", {}, undefined, 2_000).catch(() => {});
  })();
  return { data, pending, done };
}

async function captureEvenIfHidden(tabId: number, params: Record<string, unknown>): Promise<string> {
  // Everything goes through the queue, also a tab that is already in front: another thread's
  // queued capture could otherwise switch it away mid-capture. The caller gets the picture as
  // soon as there is one; the queue moves on once the capture is cleaned up.
  return new Promise<string>((resolve, reject) => {
    void oneAtATime(async () => {
      try {
        if (await pageVisible(tabId)) return resolve((await send<{ data: string }>(tabId, "Page.captureScreenshot", params, undefined, 15_000)).data);
        // In a background tab the overlay is updated lazily (see overlay()): hide it right now.
        await overlayElementHidden(tabId, true);
        let hidden: Awaited<ReturnType<typeof captureHidden>>;
        try {
          hidden = await captureHidden(tabId, params);
        } finally {
          await overlayElementHidden(tabId, false);
        }
        try {
          resolve(hidden.data ?? (await captureByActivating(tabId, params, hidden.pending)));
        } finally {
          // Before the next capture: a late stopScreencast would end that one's screencast.
          await hidden.done;
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Last resort: bring the tab to the front for the capture, then hand the user's tab back.
 * `pending` is the capture already sent while the tab was hidden: showing the tab lets it finish.
 */
async function captureByActivating(tabId: number, params: Record<string, unknown>, pending: Promise<Settled<string>>): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  ownActivations.add(tabId);
  setTimeout(() => ownActivations.delete(tabId), 2_000);
  await chrome.tabs.update(tabId, { active: true });
  try {
    // Bounded by the clock, not by attempts: a frozen page must not hold the queue for long.
    // The capture sent earlier may answer meanwhile; then that is the picture.
    let answered: Settled<string> | undefined;
    void pending.then((r) => (answered = r));
    let visible = false;
    const until = Date.now() + 1_500;
    while (!visible && Date.now() < until) {
      await sleep(100);
      if (answered?.ok) return answered.value;
      visible = await pageVisible(tabId);
    }
    if (answered?.ok) return answered.value;
    if (!visible) {
      throw new ActionError(
        "Chrome is not drawing this tab (its window is minimized or covered), so it cannot be screenshotted right now. Use browser_snapshot or browser_read instead.",
        "not_visible",
      );
    }
    const first = await Promise.race([pending, sleep(3_000).then(() => undefined)]);
    if (first?.ok) return first.value;
    return (await send<{ data: string }>(tabId, "Page.captureScreenshot", params, undefined, 15_000)).data;
  } finally {
    // Hand the user's tab back, unless they moved on to another tab meanwhile.
    const [now] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
    if (previous?.id !== undefined && previous.id !== tabId && now?.id === tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------
// Handlers

export const handlers: Record<string, (s: Session, p: Params) => Promise<unknown>> = {
  async status(s) {
    const tabs = await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)));
    const group = s.groupId === undefined ? undefined : await chrome.tabGroups.get(s.groupId).catch(() => undefined);
    return {
      session: { id: s.id, title: s.title, link: s.link, num: s.num, color: s.color, groupId: group?.id, handback: s.handback ?? null, ...(group ? { group: { title: group.title, color: group.color, windowId: group.windowId } } : {}) },
      tabs: tabs.filter(Boolean).map((t) => tabInfo(t!, s)),
      userAgent: navigator.userAgent,
    };
  },

  async "session.name"(s, p) {
    s.named = true;
    await renameSession(s, String(p.title));
    for (const id of s.tabIds) if (isAttached(id)) await showOverlay(id, s);
    return { title: s.title };
  },

  async "tabs.list"(s, p) {
    await takeInterrupt(s);
    if (p.scope === "all") {
      // Only web tabs: browser pages cannot be claimed, so there is no reason to show them.
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      return tabs.filter((t) => isWebUrl(t.url || t.pendingUrl || "")).map((t) => tabInfo(t, s));
    }
    const tabs = await Promise.all(s.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)));
    return tabs.filter(Boolean).map((t) => tabInfo(t!, s));
  },

  // No permission prompt: if the extension is connected, the tab simply opens, inside this
  // thread's tab group. Every wait below is bounded, so the agent gets an answer well before
  // the daemon gives up on the call.
  async "tabs.open"(s, p) {
    await takeInterrupt(s);
    const url = normalizeUrl(String(p.url ?? "about:blank"));
    assertWebUrl(url);
    const active = !!p.active;
    const { windowId, index } = await placeForNewTab(s);
    const tab = await chrome.tabs.create({ url, active, windowId, ...(index !== undefined ? { index } : {}) });
    const tabId = tab.id!;
    await addTab(s, tabId, { opened: true });
    if (active) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      if (s.groupId !== undefined) await chrome.tabGroups.update(s.groupId, { collapsed: false }).catch(() => {});
    }
    await waitForLoad(tabId, 15_000).catch(() => {});
    // Attaching now lets the agent act at once. A failure is not fatal: the first action
    // attaches again and reports a precise error.
    await attach(tabId).catch(() => {});
    if (isAttached(tabId)) await showOverlay(tabId, s);
    const now = await chrome.tabs.get(tabId);
    assertUsableTab(now);
    return tabInfo(now, s);
  },

  async "tabs.claim"(s, p) {
    await takeInterrupt(s);
    const tabId = Number(p.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => {
      throw new ActionError(`Tab ${tabId} does not exist.`, "tab_closed");
    });
    const owner = await sessionForTab(tabId);
    if (owner && owner.id !== s.id) throw new ActionError("Another T3 thread is already using that tab.", "ownership_conflict");
    const url = tab.url || tab.pendingUrl || "";
    if (!isWebUrl(url)) throw new ActionError(notWebPageMessage(url), "restricted");
    await addTab(s, tabId);
    await attach(tabId);
    await showOverlay(tabId, s);
    return tabInfo(await chrome.tabs.get(tabId), s);
  },

  async "tabs.close"(s, p) {
    const tabId = Number(p.tabId);
    assertOwnsTab(s, tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    return { closed: tabId };
  },

  async "tabs.navigate"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const action = p.action ?? "goto";
    if (action === "goto") {
      const url = normalizeUrl(String(p.url));
      assertWebUrl(url);
      await chrome.tabs.update(tabId, { url });
    } else if (action === "back") await chrome.tabs.goBack(tabId);
    else if (action === "forward") await chrome.tabs.goForward(tabId);
    else if (action === "reload") await chrome.tabs.reload(tabId);
    else throw new ActionError(`Unknown navigation action "${action}".`);
    onTabNavigated(tabId);
    await waitForLoad(tabId);
    // Going back can leave the web (e.g. to a browser page the tab showed earlier).
    assertUsableTab(await chrome.tabs.get(tabId));
    return pageState(tabId);
  },

  async "page.snapshot"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    await send(tabId, "Accessibility.enable").catch(() => {});
    const { nodes } = await send<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree", {});

    // Graft same-process iframes in at their <iframe> node.
    const frames = new Map<number, AXNode[]>();
    for (const n of nodes) {
      if (n.role?.value !== "Iframe" || n.backendDOMNodeId === undefined) continue;
      try {
        const { node } = await send(tabId, "DOM.describeNode", { backendNodeId: n.backendDOMNodeId });
        if (!node.frameId) continue;
        const sub = await send<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree", { frameId: node.frameId });
        frames.set(n.backendDOMNodeId, sub.nodes);
      } catch {
        // cross-process iframe: not reachable from this target in v1
      }
    }

    let scoped = nodes;
    if (p.selector) {
      const { result } = await send(tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(p.selector)})` });
      if (!result?.objectId) throw new ActionError(`No element matches selector ${p.selector}.`);
      const { node } = await send(tabId, "DOM.describeNode", { objectId: result.objectId });
      const rootAx = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
      if (!rootAx) throw new ActionError(`The element matching ${p.selector} is not in the accessibility tree.`);
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const subtree: AXNode[] = [];
      const stack = [rootAx.nodeId];
      while (stack.length) {
        const n = byId.get(stack.pop()!);
        if (!n) continue;
        subtree.push(n.nodeId === rootAx.nodeId ? { ...n, parentId: undefined } : n);
        stack.push(...(n.childIds ?? []));
      }
      scoped = subtree;
    }

    const refs = refsFor(tabId);
    const result = formatAXTree(scoped, refs, { interactive: !!p.interactive, maxDepth: p.maxDepth, maxChars: p.maxChars }, frames);
    if (!p.selector) refs.retainOnly(result.refs);
    const dialog = dialogs.get(tabId);
    return {
      tabId,
      url: tab.url,
      title: tab.title,
      snapshot: result.text || "(empty page)",
      refCount: result.refs.size,
      ...(dialog ? { dialog } : {}),
    };
  },

  async "page.click"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    let x: number;
    let y: number;
    let backendNodeId: number | undefined;
    if (p.ref) {
      backendNodeId = resolveRef(tabId, p.ref).backendNodeId;
      ({ x, y } = await clickablePoint(tabId, backendNodeId));
    } else if (typeof p.x === "number" && typeof p.y === "number") {
      ({ x, y } = p as { x: number; y: number });
    } else throw new ActionError("Pass a ref from browser_snapshot (or x/y coordinates).");
    // In a hidden tab Chrome can drop raw mouse input entirely (seen on Windows: the press and
    // release never reach the page). Watch for the click event; if it never arrives, click the
    // element through the DOM instead. Visible tabs always get real mouse input only.
    const plainClick = backendNodeId !== undefined && (p.button ?? "left") === "left" && !p.doubleClick;
    const hidden = plainClick && !(await pageVisible(tabId));
    const FLAG = "__t3BrowserClickSeen";
    if (hidden) {
      await send(tabId, "Runtime.evaluate", {
        expression: `window.${FLAG} = false; addEventListener("click", () => { window.${FLAG} = true; }, { capture: true, once: true });`,
      }).catch(() => {});
    }
    await mouseClick(tabId, x, y, p.button ?? "left", p.doubleClick ? 2 : 1);
    if (hidden && !dialogs.has(tabId)) {
      await sleep(150);
      const seen = await send<{ result: { value?: boolean } }>(tabId, "Runtime.evaluate", { expression: `window.${FLAG} !== false`, returnByValue: true })
        .then((r) => r.result.value === true)
        .catch(() => true); // page already navigated away: the click landed
      if (!seen) {
        const objectId = await objectIdFor(tabId, backendNodeId!);
        await unlessDialog(tabId, callOn(tabId, objectId, "function () { this.click(); }", []));
      }
    }
    return afterAction(tabId, tab.url);
  },

  async "page.hover"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const { x, y } = await clickablePoint(tabId, resolveRef(tabId, p.ref).backendNodeId);
    await glideTo(tabId, x, y);
    // Here the move is the action itself. In a hidden tab Chrome delivers it late (1-5s, see
    // mouseClick): wait for it, but not for ever.
    const moved = send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    moved.catch(() => {});
    if (await pageVisible(tabId)) await moved;
    else await Promise.race([moved, sleep(1_500)]);
    return pageState(tabId);
  },

  async "page.type"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    const text = String(p.text ?? "");
    if (p.ref) {
      const { backendNodeId } = resolveRef(tabId, p.ref);
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
      const field = await centerOf(tabId, backendNodeId);
      if (field) await glideTo(tabId, field.x, field.y, "Typing");
      try {
        await send(tabId, "DOM.focus", { backendNodeId });
      } catch {
        // Some widgets only take focus from a click.
        const { x, y } = await clickablePoint(tabId, backendNodeId);
        await mouseClick(tabId, x, y, "left", 1, "Typing");
      }
      if (p.clear !== false) {
        const objectId = await objectIdFor(tabId, backendNodeId);
        await callOn(
          tabId,
          objectId,
          `function () {
            const el = this;
            if (typeof el.select === "function" && "value" in el) { el.select(); return; }
            if (el.isContentEditable) {
              const r = document.createRange(); r.selectNodeContents(el);
              const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
            }
          }`,
        );
        if (!text) await pressKey(tabId, "Delete");
      }
    }
    if (!p.ref) await overlay(tabId, "activity", "Typing");
    try {
      if (text) await typeText(tabId, s, text);
      // Esc while typing: stop here, and certainly do not press Enter.
      await takeInterrupt(s);
      if (p.submit && !dialogs.has(tabId)) await pressKey(tabId, "Enter");
    } finally {
      await overlay(tabId, "activity", null);
    }
    return afterAction(tabId, tab.url);
  },

  async "page.press"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    const keys: string[] = Array.isArray(p.keys) ? p.keys : [String(p.key ?? p.keys)];
    for (const k of keys) await pressKey(tabId, k);
    return afterAction(tabId, tab.url);
  },

  async "page.scroll"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    if (p.ref && !p.direction) {
      const { backendNodeId } = resolveRef(tabId, p.ref);
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } else {
      const amount = Number(p.amount ?? 600);
      const dir = String(p.direction ?? "down");
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      // Scroll the nearest scrollable container under the ref (or the page). Programmatic
      // scrolling works in background tabs, where synthetic wheel events are never delivered.
      const fn = `function (dx, dy) {
        const canScroll = (el) => {
          if (!el || el === document.body || el === document.documentElement) return false;
          const st = getComputedStyle(el);
          return (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) ||
                 (/(auto|scroll|overlay)/.test(st.overflowX) && el.scrollWidth > el.clientWidth);
        };
        let el = this && this.nodeType ? (this.nodeType === 1 ? this : this.parentElement) : null;
        while (el && !canScroll(el)) el = el.parentElement;
        const target = el || document.scrollingElement || document.documentElement;
        target.scrollBy({ left: dx, top: dy, behavior: "instant" });
        return true;
      }`;
      if (p.ref) await callOn(tabId, await objectIdFor(tabId, resolveRef(tabId, p.ref).backendNodeId), fn, [dx, dy]);
      else await send(tabId, "Runtime.evaluate", { expression: `(${fn}).call(null, ${dx}, ${dy})`, returnByValue: true });
      await sleep(150);
    }
    const { result } = await send(tabId, "Runtime.evaluate", {
      expression: "({x: scrollX, y: scrollY, maxY: document.documentElement.scrollHeight - innerHeight})",
      returnByValue: true,
    });
    return { ...(await pageState(tabId)), scroll: result.value };
  },

  async "page.select"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const values: string[] = Array.isArray(p.values) ? p.values.map(String) : [String(p.values ?? p.value)];
    const { backendNodeId } = resolveRef(tabId, p.ref);
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const box = await centerOf(tabId, backendNodeId);
    if (box) {
      await glideTo(tabId, box.x, box.y, "Selecting");
      await overlay(tabId, "click", box.x, box.y);
      await overlay(tabId, "activity", null);
    }
    const objectId = await objectIdFor(tabId, backendNodeId);
    const selected = await callOn<string[] | string>(
      tabId,
      objectId,
      `function (wanted) {
        if (!(this instanceof HTMLSelectElement)) return "not-a-select";
        const opts = [...this.options];
        const picked = [];
        for (const o of opts) {
          const hit = wanted.some(w => o.value === w || o.label.trim() === w || o.text.trim() === w);
          if (hit && (this.multiple || picked.length === 0)) { o.selected = true; picked.push(o.label || o.value); }
          else if (this.multiple) o.selected = false;
        }
        if (!picked.length) return "no-match:" + opts.map(o => o.label || o.value).slice(0, 30).join(" | ");
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return picked;
      }`,
      [values],
    );
    if (selected === "not-a-select") throw new ActionError("That element is not a native <select>. Click it to open the menu, then click an option.");
    if (typeof selected === "string") throw new ActionError(`No option matches. Options: ${selected.slice("no-match:".length)}`);
    return { ...(await pageState(tabId)), selected };
  },

  async "page.screenshot"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const format = p.format === "png" ? "png" : "jpeg";
    const params: Record<string, unknown> = { format, ...(format === "jpeg" ? { quality: 80 } : {}) };
    if (p.fullPage) {
      const m = await send(tabId, "Page.getLayoutMetrics");
      const width = Math.ceil(m.cssContentSize.width);
      const height = Math.min(Math.ceil(m.cssContentSize.height), 12_000);
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    await overlay(tabId, "hide");
    try {
      const data = await captureEvenIfHidden(tabId, params);
      return { ...(await pageState(tabId)), mimeType: `image/${format}`, data };
    } finally {
      await showOverlay(tabId, s);
    }
  },

  /**
   * The control page's Peek button. Unlike page.screenshot it never consumes an Esc/Stop
   * notice meant for the agent, and it refuses once the thread is stopped.
   */
  async "page.peek"(s, p) {
    const tabId = Number(p.tabId);
    if (s.interrupted) throw new ActionError("This thread is stopped.", "interrupted");
    assertOwnsTab(s, tabId);
    assertUsableTab(await chrome.tabs.get(tabId));
    if (dialogs.has(tabId)) throw new ActionError("A dialog is open on this tab; the agent has to answer it first.", "dialog_open");
    // Leave the tab exactly as it was: overlay only if it was showing, debugger only if attached.
    const wasAttached = isAttached(tabId);
    const hadOverlay = overlayShown.has(tabId);
    if (!wasAttached) await attach(tabId);
    if (hadOverlay) await overlay(tabId, "hide");
    try {
      return { mimeType: "image/jpeg", data: await captureEvenIfHidden(tabId, { format: "jpeg", quality: 70 }) };
    } finally {
      if (hadOverlay) await showOverlay(tabId, s);
      // Only undo our own attach, and never under an agent command that started meanwhile
      // (this peek counts as one busy command itself). The idle sweep tidies up otherwise.
      if (!wasAttached && busyCount(tabId) <= 1 && !relayTabs.has(tabId) && !dialogs.has(tabId)) await detachIdle(tabId);
    }
  },

  async "page.read"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const offset = Number(p.offset ?? 0);
    const maxChars = Number(p.maxChars ?? 20_000);
    const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const root = ${p.selector ? `document.querySelector(${JSON.stringify(p.selector)})` : "document.body"};
        return root ? root.innerText : null;
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new ActionError(exceptionDetails.text);
    if (result.value === null) throw new ActionError(`No element matches selector ${p.selector}.`);
    const text = String(result.value ?? "").replace(/\n{3,}/g, "\n\n");
    return {
      ...(await pageState(tabId)),
      text: text.slice(offset, offset + maxChars),
      totalChars: text.length,
      ...(offset + maxChars < text.length ? { nextOffset: offset + maxChars } : {}),
    };
  },

  async "page.eval"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const res = await unlessDialog(
      tabId,
      send(tabId, "Runtime.evaluate", { expression: String(p.expression), awaitPromise: true, returnByValue: true, userGesture: true, timeout: 30_000 }),
    );
    if (!res) return { value: null, dialog: dialogs.get(tabId) };
    const { result, exceptionDetails } = res;
    if (exceptionDetails) throw new ActionError(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return { value: result.value ?? (result.type === "undefined" ? null : result.description) };
  },

  async "page.wait"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    const timeout = Math.min(Number(p.timeoutMs ?? 10_000), 60_000);
    const start = Date.now();
    if (!p.text && !p.selector && !p.urlIncludes) {
      if (p.ms) {
        await sleep(Math.min(Number(p.ms), 30_000));
        return pageState(tabId);
      }
      await waitForLoad(tabId, timeout);
      return pageState(tabId);
    }
    const expr = `(() => {
      ${p.text ? `if (!document.body || !document.body.innerText.includes(${JSON.stringify(p.text)})) return ${!!p.gone};` : ""}
      ${p.selector ? `{ const el = document.querySelector(${JSON.stringify(p.selector)}); if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return ${!!p.gone}; }` : ""}
      ${p.urlIncludes ? `if (!location.href.includes(${JSON.stringify(p.urlIncludes)})) return ${!!p.gone};` : ""}
      return ${!p.gone};
    })()`;
    while (Date.now() - start < timeout) {
      await takeInterrupt(s);
      const { result } = await send(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true }).catch(() => ({ result: { value: false } }));
      if (result.value === true) return { ...(await pageState(tabId)), waitedMs: Date.now() - start };
      await sleep(250);
    }
    throw new ActionError(`Timed out after ${timeout}ms waiting for ${JSON.stringify({ text: p.text, selector: p.selector, urlIncludes: p.urlIncludes, gone: !!p.gone })}.`, "timeout");
  },

  async "page.upload"(s, p) {
    const tabId = Number(p.tabId);
    const tab = await prepare(s, tabId);
    const files: string[] = (Array.isArray(p.files) ? p.files : [p.files]).map(String);
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: resolveRef(tabId, p.ref).backendNodeId });
    return { ...(await pageState(tabId)), uploaded: files };
  },

  async "page.dialog"(s, p) {
    const tabId = Number(p.tabId);
    await takeInterrupt(s);
    assertOwnsTab(s, tabId);
    const dialog = dialogs.get(tabId);
    if (!dialog) {
      // A dialog that opened while the debugger was detached (idle) was never reported: try anyway.
      if (!isAttached(tabId)) await attach(tabId);
      try {
        await send(tabId, "Page.handleJavaScriptDialog", { accept: !!p.accept, promptText: p.promptText });
      } catch {
        throw new ActionError("No dialog is open on this tab.");
      }
      return { handled: { type: "dialog" }, accepted: !!p.accept };
    }
    await send(tabId, "Page.handleJavaScriptDialog", { accept: !!p.accept, promptText: p.promptText });
    dialogs.delete(tabId);
    return { handled: dialog, accepted: !!p.accept };
  },

  // browser_done: close the agent's tabs except keepTabIds, which leave the group.
  // keepGroup (the thread ended without browser_done): keep every tab, in its group, collapsed,
  // so the user still finds what the agent was doing, but with the debugger and overlay gone.
  async "session.release"(s, p) {
    const keep = new Set<number>((p.keepTabIds ?? []).map(Number));
    const keepGroup = p.keepGroup === true;
    const closeTabs = !keepGroup && p.closeTabs !== false;
    for (const tabId of [...s.tabIds]) {
      await hideOverlay(tabId);
      await detach(tabId);
      // The in-memory attach state is lost if the service worker restarted; detach anyway so
      // tabs that stay open never keep Chrome's "debugging this browser" bar.
      await chrome.debugger.detach({ tabId }).catch(() => {});
      forgetTab(tabId);
      relayTabs.delete(tabId);
      if (closeTabs && !keep.has(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
      else {
        if (!keepGroup) await chrome.tabs.ungroup(tabId).catch(() => {});
        // The tab is the user's again: no thread badge (the next thread may get this number).
        await unmarkTab(tabId);
      }
    }
    const kept = keepGroup ? s.tabIds.length : closeTabs ? s.tabIds.filter((id) => keep.has(id)).length : s.tabIds.length;
    if (keepGroup && s.groupId !== undefined) {
      // A finished thread's group gives up its number and colour, which a new thread may get.
      // Unlink it from the thread first: recolouring fires the "user recoloured a group"
      // listener, which must not adopt grey and badge the tabs again.
      const groupId = s.groupId;
      s.groupId = undefined;
      await persist();
      // Collapsing would pull the user off a tab they are looking at; leave the group open then.
      const watched = await chrome.tabs.query({ groupId, active: true }).catch(() => []);
      await chrome.tabGroups.update(groupId, { title: threadGroupTitle(undefined, s.title), color: "grey", ...(watched.length ? {} : { collapsed: true }) }).catch(() => {});
    }
    await dropSession(s.id);
    return { released: true, kept };
  },

  /**
   * The agent gives the user a tab for a step only they can do (log in, 2FA, a CAPTCHA). The
   * debugger lets go, and the page shows the agent's request with Hand back.
   */
  async "session.handover"(s, p) {
    await takeInterrupt(s);
    const tabId = Number(p.tabId);
    assertOwnsTab(s, tabId);
    assertUsableTab(await chrome.tabs.get(tabId));
    const ask = String(p.message ?? "").trim().slice(0, 300);
    await setHandback(s, tabId, ask);
    await detach(tabId);
    relayTabs.delete(tabId);
    if (s.groupId !== undefined) await chrome.tabGroups.update(s.groupId, { collapsed: false }).catch(() => {});
    await showYourTurn(tabId, s);
    return {
      tab: tabId,
      canHandBack: !!s.link,
      next: s.link
        ? "The tab shows your request with a Hand back button. Tell the user in chat what you need, then end your turn: when they hand the tab back, their note arrives in this thread as a new message."
        : "The tab shows your request. This agent is not in a T3 Code thread, so the user will answer in chat.",
    };
  },

  /** The control page's Hand back (the page's own button goes through the background). */
  async "session.handback"(s, p) {
    return handBack(s, String(p.note ?? ""));
  },

  /** Stop the thread as if the user pressed Stop (used by the remote control page). */
  async "session.stop"(s, p) {
    await stopHandler?.(s, String(p.reason ?? "pressed Stop on the T3 Browser control page"));
    return { stopped: s.id };
  },

  /** Load the build that is on disk now (used by `t3-browser reload-extension` after a rebuild). */
  async "extension.reload"() {
    setTimeout(() => chrome.runtime.reload(), 150);
    return { reloading: true, version: chrome.runtime.getManifest().version };
  },

  // ---- CDP relay (agent-browser `connect`) --------------------------------------------

  async "cdp.attach"(s, p) {
    const tabId = Number(p.tabId);
    await prepare(s, tabId);
    relayTabs.add(tabId);
    return { attached: tabId };
  },

  async "cdp.detach"(_s, p) {
    relayTabs.delete(Number(p.tabId));
    return {};
  },

  async "cdp.send"(s, p) {
    const tabId = Number(p.tabId);
    await takeInterrupt(s);
    assertOwnsTab(s, tabId);
    const method = String(p.method);
    if (method === "Page.navigate" && p.params?.url) assertWebUrl(String(p.params.url));
    // Agents work in the background; only browser_open with focus brings a tab forward.
    if (method === "Page.bringToFront") return {};
    if (!isAttached(tabId)) await attach(tabId);
    try {
      return await send(tabId, method, p.params, p.childSessionId);
    } catch (err) {
      throw new ActionError(String((err as Error).message ?? err), "cdp_error");
    }
  },
};

/** Tabs whose CDP events are streamed to the daemon for the relay. */
export const relayTabs = new Set<number>();

export async function dispatch(info: SessionInfo, method: string, params: Params = {}): Promise<unknown> {
  const handler = handlers[method];
  if (!handler) throw new ActionError(`Unknown method ${method}`, "unknown_method");
  const s = await getSession(info);
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) return handler(s, params);
  const done = markBusy(tabId);
  try {
    return await handler(s, params);
  } finally {
    done();
  }
}
