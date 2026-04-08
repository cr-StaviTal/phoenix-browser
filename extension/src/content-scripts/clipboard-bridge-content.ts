/**
 * Clipboard Bridge Content Script -- injected into all pages.
 *
 * Detects copy events and determines whether the copied text was visible in the
 * viewport at the time of the copy. Sends a structured message to the service
 * worker which forwards it to a Rust native messaging host.
 *
 * Visibility heuristics:
 *   1. If the user has a text selection (window.getSelection), check whether the
 *      selection's bounding rect intersects the viewport.
 *   2. If the copy was triggered programmatically (no selection / empty selection)
 *      fall back to reading the clipboard and searching all visible text nodes
 *      for the copied string.
 *
 * This file must be fully self-contained: NO imports from extension modules.
 */

((): void => {

console.log('[ClipboardBridge] Content script loaded on', location.href);

// ---- Inject a script into the PAGE's main world from web_accessible_resources ----
function injectPageScript(): void {
  // The CSP blocks inline scripts, but we can load a script from the extension's
  // web_accessible_resources (which is exempt from the page's CSP).
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected/clipboard-interceptor.js');
  script.onload = () => {
    console.log('[ClipboardBridge] Page script injected from web_accessible_resources');
    script.remove();
  };
  script.onerror = () => {
    console.error('[ClipboardBridge] Failed to inject page script');
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

injectPageScript();

// ---- Local types ----

interface ClipboardBridgeMessage {
  type: 'clipboard-bridge:copy-detected';
  tabUrl: string;
  data: {
    text: string;
    is_visible: boolean;
    url: string;
  };
}

// ---- Viewport helpers ----

function rectInViewport(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function isSelectionVisible(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;

  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const rect = range.getBoundingClientRect();
    if (rectInViewport(rect)) return true;
  }
  return false;
}

function textExistsInVisibleNodes(needle: string): boolean {
  if (!needle || needle.length === 0) return false;

  const lowerNeedle = needle.toLowerCase();
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        const text = node.textContent;
        if (!text || text.trim().length === 0) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let current: Node | null;
  while ((current = walker.nextNode())) {
    const parent = current.parentElement;
    if (!parent) continue;

    const rect = parent.getBoundingClientRect();
    if (!rectInViewport(rect)) continue;

    const nodeText = current.textContent;
    if (nodeText && nodeText.toLowerCase().includes(lowerNeedle)) {
      return true;
    }
  }

  return false;
}

// ---- Messaging ----

function sendMessage(msg: ClipboardBridgeMessage): void {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) {
        // Extension context invalidated, ignore
      }
    });
  } catch {
    // Extension context invalidated
  }
}

// ---- Handle clipboard writes from the page (main world injection) ----

document.addEventListener(
  '__phoenix_clipboard_write',
  (e: Event) => {
    const text = (e as CustomEvent<string>).detail;
    if (!text || text.length === 0) return;

    const visible = textExistsInVisibleNodes(text);
    console.log('[ClipboardBridge] writeText intercepted (content script):', text.substring(0, 120), '| visible:', visible);
    sendMessage({
      type: 'clipboard-bridge:copy-detected',
      tabUrl: location.href,
      data: {
        text: text.substring(0, 8192),
        is_visible: visible,
        url: location.href,
      },
    });
  },
);

// ---- Copy event handler (DOM 'copy' event) ----

document.addEventListener(
  'copy',
  (event: ClipboardEvent) => {
    const sel = window.getSelection();
    const selectedText = sel?.toString() ?? '';

    if (selectedText.length > 0) {
      const visible = isSelectionVisible();
      sendMessage({
        type: 'clipboard-bridge:copy-detected',
        tabUrl: location.href,
        data: {
          text: selectedText.substring(0, 8192),
          is_visible: visible,
          url: location.href,
        },
      });
    } else {
      const clipData = event.clipboardData?.getData('text/plain') ?? '';

      if (clipData.length > 0) {
        const visible = textExistsInVisibleNodes(clipData);
        sendMessage({
          type: 'clipboard-bridge:copy-detected',
          tabUrl: location.href,
          data: {
            text: clipData.substring(0, 8192),
            is_visible: visible,
            url: location.href,
          },
        });
      } else {
        navigator.clipboard
          .readText()
          .then((clipText) => {
            if (!clipText || clipText.length === 0) return;
            const visible = textExistsInVisibleNodes(clipText);
            sendMessage({
              type: 'clipboard-bridge:copy-detected',
              tabUrl: location.href,
              data: {
                text: clipText.substring(0, 8192),
                is_visible: visible,
                url: location.href,
              },
            });
          })
          .catch(() => {});
      }
    }
  },
  true,
);

})();
