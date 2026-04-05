/**
 * Chrome API mock setup for vitest.
 *
 * Provides in-memory implementations of every Chrome extension API surface
 * used by Phoenix Shield so that unit tests can run without a browser.
 */
import { vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Listener<T extends (...args: any[]) => any> = T;

/** Minimal chrome-style event that supports addListener / removeListener. */
function makeChromeEvent<T extends (...args: any[]) => any>() {
  const listeners = new Set<Listener<T>>();
  return {
    addListener: vi.fn((cb: Listener<T>) => {
      listeners.add(cb);
    }),
    removeListener: vi.fn((cb: Listener<T>) => {
      listeners.delete(cb);
    }),
    hasListener: vi.fn((cb: Listener<T>) => listeners.has(cb)),
    /** Test-only: fire all registered listeners. */
    _fire: (...args: Parameters<T>) => {
      for (const cb of listeners) {
        cb(...args);
      }
    },
    /** Test-only: clear all listeners. */
    _clear: () => listeners.clear(),
    /** Test-only: current listener count. */
    get _size() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------------------
// chrome.storage.local
// ---------------------------------------------------------------------------

let storageData: Record<string, unknown> = {};

const storageLocal = {
  get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
    if (keys === null || keys === undefined) return { ...storageData };
    if (typeof keys === 'string') {
      return keys in storageData ? { [keys]: storageData[keys] } : {};
    }
    if (Array.isArray(keys)) {
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in storageData) result[k] = storageData[k];
      }
      return result;
    }
    // Object with defaults
    const result: Record<string, unknown> = {};
    for (const [k, defaultVal] of Object.entries(keys)) {
      result[k] = k in storageData ? storageData[k] : defaultVal;
    }
    return result;
  }),
  set: vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(storageData, items);
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    const list = typeof keys === 'string' ? [keys] : keys;
    for (const k of list) delete storageData[k];
  }),
  getBytesInUse: vi.fn(async () => JSON.stringify(storageData).length),
  clear: vi.fn(async () => {
    storageData = {};
  }),
};

// ---------------------------------------------------------------------------
// chrome.runtime
// ---------------------------------------------------------------------------

const onMessage = makeChromeEvent<
  (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ) => boolean | void
>();

const runtimeMock = {
  sendMessage: vi.fn(),
  onMessage,
  getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
  id: 'mock-extension-id',
};

// ---------------------------------------------------------------------------
// chrome.alarms
// ---------------------------------------------------------------------------

const onAlarm = makeChromeEvent<(alarm: chrome.alarms.Alarm) => void>();

const alarmsMock = {
  create: vi.fn(),
  clear: vi.fn(async () => true),
  getAll: vi.fn(async () => []),
  onAlarm,
};

// ---------------------------------------------------------------------------
// chrome.webNavigation
// ---------------------------------------------------------------------------

const webNavigationMock = {
  onCompleted: makeChromeEvent<(details: any) => void>(),
  onBeforeNavigate: makeChromeEvent<(details: any) => void>(),
};

// ---------------------------------------------------------------------------
// chrome.management
// ---------------------------------------------------------------------------

const managementMock = {
  getAll: vi.fn(async () => []),
  onInstalled: makeChromeEvent<(info: any) => void>(),
  onUninstalled: makeChromeEvent<(id: string) => void>(),
  onEnabled: makeChromeEvent<(info: any) => void>(),
  onDisabled: makeChromeEvent<(info: any) => void>(),
};

// ---------------------------------------------------------------------------
// chrome.cookies
// ---------------------------------------------------------------------------

const cookiesMock = {
  onChanged: makeChromeEvent<(changeInfo: any) => void>(),
};

// ---------------------------------------------------------------------------
// chrome.notifications
// ---------------------------------------------------------------------------

const notificationsMock = {
  create: vi.fn((_opts: any, cb?: (id: string) => void) => {
    cb?.('mock-notification-id');
  }),
};

// ---------------------------------------------------------------------------
// chrome.declarativeNetRequest
// ---------------------------------------------------------------------------

const declarativeNetRequestMock = {
  updateDynamicRules: vi.fn(),
  RuleActionType: { BLOCK: 'block' as const, ALLOW: 'allow' as const, REDIRECT: 'redirect' as const },
  ResourceType: {
    MAIN_FRAME: 'main_frame' as const,
    SUB_FRAME: 'sub_frame' as const,
    SCRIPT: 'script' as const,
    IMAGE: 'image' as const,
    XMLHTTPREQUEST: 'xmlhttprequest' as const,
  },
};

// ---------------------------------------------------------------------------
// Assemble the global `chrome` object
// ---------------------------------------------------------------------------

const chromeMock = {
  storage: { local: storageLocal },
  runtime: runtimeMock,
  alarms: alarmsMock,
  webNavigation: webNavigationMock,
  management: managementMock,
  cookies: cookiesMock,
  notifications: notificationsMock,
  declarativeNetRequest: declarativeNetRequestMock,
};

// Expose on globalThis so modules that reference `chrome.*` find it.
(globalThis as any).chrome = chromeMock;

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Clear in-memory storage
  storageData = {};

  // Reset all vi.fn() call counts & implementations
  storageLocal.get.mockClear();
  storageLocal.set.mockClear();
  storageLocal.remove.mockClear();
  storageLocal.getBytesInUse.mockClear();
  storageLocal.clear.mockClear();

  runtimeMock.sendMessage.mockClear();
  onMessage.addListener.mockClear();
  onMessage.removeListener.mockClear();
  onMessage._clear();

  alarmsMock.create.mockClear();
  alarmsMock.clear.mockClear();
  alarmsMock.getAll.mockClear();
  onAlarm._clear();

  webNavigationMock.onCompleted._clear();
  webNavigationMock.onBeforeNavigate._clear();

  managementMock.getAll.mockClear();
  managementMock.onInstalled._clear();
  managementMock.onUninstalled._clear();
  managementMock.onEnabled._clear();
  managementMock.onDisabled._clear();

  cookiesMock.onChanged._clear();

  notificationsMock.create.mockClear();

  declarativeNetRequestMock.updateDynamicRules.mockClear();
});

// Re-export for tests that need direct access to fire events or inspect mocks.
export {
  chromeMock,
  storageLocal,
  runtimeMock,
  onMessage,
  alarmsMock,
  onAlarm,
  webNavigationMock,
  managementMock,
  cookiesMock,
  notificationsMock,
  declarativeNetRequestMock,
};
