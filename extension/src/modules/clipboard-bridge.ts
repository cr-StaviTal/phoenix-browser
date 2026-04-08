import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { EventTypes, ClipboardBridgePayload } from '../types/events';

/**
 * Native messaging host name. Must match the "name" field in the native host
 * manifest JSON that Chrome looks up on the OS.
 */
const NATIVE_HOST_NAME = 'com.phoenix.shield';

/**
 * Maximum time (ms) to wait before attempting to reconnect to the native host
 * after an unexpected disconnect.
 */
const RECONNECT_DELAY_MS = 5_000;

/**
 * Maximum reconnection attempts before giving up (resets on successful message).
 */
const MAX_RECONNECT_ATTEMPTS = 10;

interface ClipboardBridgeMessage {
  type: 'clipboard-bridge:copy-detected';
  tabUrl: string;
  data: {
    text: string;
    is_visible: boolean;
    url: string;
  };
}

/**
 * ClipboardBridge module — receives copy-detection messages from the
 * clipboard-bridge content script and forwards them to a Rust native
 * messaging host over chrome.runtime.connectNative.
 *
 * The native host receives JSON payloads of the form:
 *   { "text": string, "is_visible": boolean, "url": string }
 *
 * Chrome handles the 4-byte length-prefix framing automatically when using
 * the Port-based API (connectNative), so neither side needs to manually
 * encode/decode the length header — Chrome's implementation adds the prefix
 * on write and strips it on read.
 */
export class ClipboardBridge implements PhoenixModule {
  readonly id = 'clipboard-bridge';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private port: chrome.runtime.Port | null = null;
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private messageListener:
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: { received: boolean }) => void,
      ) => boolean | undefined)
    | null = null;

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // Connect to native host on startup
    this.connectNative();

    // Listen for content-script messages
    this.messageListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: { received: boolean }) => void,
    ): boolean | undefined => {
      const msg = message as ClipboardBridgeMessage;
      if (msg?.type !== 'clipboard-bridge:copy-detected') {
        return undefined; // not ours
      }

      this.handleCopyDetected(msg);
      sendResponse({ received: true });
      return false; // synchronous response
    };

    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  destroy(): void {
    this.enabled = false;

    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.disconnectNative();
    this.bus = null;
  }

  getStatus(): ModuleStatus {
    return {
      id: this.id,
      enabled: this.enabled,
      lastActivity: this.lastActivity,
      eventCount: this.eventCount,
      errors: this.errors.slice(-10),
    };
  }

  // ---- Native messaging ----

  private connectNative(): void {
    try {
      this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

      this.port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message ?? 'unknown';
        console.warn(
          `[ClipboardBridge] Native host disconnected: ${error}`,
        );
        this.errors.push(`Native host disconnected: ${error}`);
        this.port = null;
        this.scheduleReconnect();
      });

      // The native host can optionally send messages back (e.g. ack, config).
      // For now we just log them.
      this.port.onMessage.addListener((msg: unknown) => {
        console.log('[ClipboardBridge] Message from native host:', msg);
        this.lastActivity = Date.now();
      });

      // Reset reconnect counter on successful connection
      this.reconnectAttempts = 0;
      console.log('[ClipboardBridge] Connected to native host');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Failed to connect to native host: ${errMsg}`);
      console.error(`[ClipboardBridge] Connect failed: ${errMsg}`);
      this.port = null;
      this.scheduleReconnect();
    }
  }

  private disconnectNative(): void {
    if (this.port) {
      try {
        this.port.disconnect();
      } catch {
        // already disconnected
      }
      this.port = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.errors.push(
        `Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      return;
    }

    // Exponential back-off: 5s, 10s, 20s, …
    const delay = RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled) {
        this.connectNative();
      }
    }, delay);
  }

  // ---- Copy event handling ----

  private handleCopyDetected(msg: ClipboardBridgeMessage): void {
    const { text, is_visible, url } = msg.data;

    this.lastActivity = Date.now();
    this.eventCount++;

    console.log(
      `[ClipboardBridge] Copy detected | visible=${is_visible} | url=${url} | text=${text.substring(0, 120)}`,
    );

    // Build the payload that goes to the native host
    const nativePayload = { text, is_visible, url };

    // Forward to native host
    if (this.port) {
      try {
        this.port.postMessage(nativePayload);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Failed to post to native host: ${errMsg}`);
        // Port is dead, null it and schedule reconnect
        this.port = null;
        this.scheduleReconnect();
      }
    } else {
      this.errors.push('Native host not connected, message dropped');
    }

    // Also publish to the internal event bus so EdrReporter / ForensicLogger
    // can pick it up.
    if (this.bus) {
      const payload: ClipboardBridgePayload = {
        text: text.substring(0, 256), // truncate for internal logging
        is_visible,
        url,
        forwarded_to_native: this.port !== null,
      };
      this.bus.publish(
        EventBus.createEvent(
          EventTypes.CLIPBOARD_BRIDGE_COPY,
          this.id,
          payload,
          'info',
        ),
      );
    }
  }
}
