/**
 * Governance Content Script -- injected into all pages.
 *
 * Monitors copy, cut, and paste events and forwards them to the service worker
 * for policy enforcement.
 *
 * This file must be fully self-contained: NO imports from extension modules.
 */

((): void => {

// ---- Local types (mirrors of messages.ts / ContentResponse, kept inline) ----

interface GovernanceMessage {
  type: 'governance:copy-check' | 'governance:paste-check';
  tabUrl: string;
  data: Record<string, unknown>;
}

interface GovernanceResponse {
  action: 'allow' | 'block' | 'warn';
  message?: string;
}

// ---- Warning overlay (mirrors dlp-content.ts pattern) ----

function showWarningOverlay(message: string): void {
  const existing = document.getElementById('phoenix-governance-warning');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'phoenix-governance-warning';
  overlay.setAttribute(
    'style',
    [
      'position:fixed',
      'top:0',
      'left:0',
      'width:100vw',
      'height:100vh',
      'background:rgba(0,0,0,0.7)',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
    ].join(';'),
  );

  const box = document.createElement('div');
  box.setAttribute(
    'style',
    [
      'background:#fff',
      'color:#b91c1c',
      'padding:32px 48px',
      'border-radius:12px',
      'font-family:system-ui,sans-serif',
      'font-size:16px',
      'max-width:480px',
      'text-align:center',
      'box-shadow:0 8px 32px rgba(0,0,0,0.3)',
    ].join(';'),
  );

  const title = document.createElement('h2');
  title.textContent = 'Phoenix Shield';
  title.setAttribute('style', 'margin:0 0 12px;font-size:20px;');

  const msg = document.createElement('p');
  msg.textContent = message;
  msg.setAttribute('style', 'margin:0 0 20px;color:#333;');

  const btn = document.createElement('button');
  btn.textContent = 'Dismiss';
  btn.setAttribute(
    'style',
    'padding:8px 24px;border:none;border-radius:6px;background:#b91c1c;color:#fff;cursor:pointer;font-size:14px;',
  );
  btn.addEventListener('click', () => overlay.remove());

  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Auto-dismiss after 8 seconds
  setTimeout(() => overlay.remove(), 8000);
}

// ---- Messaging helper ----

function sendMessage(msg: GovernanceMessage): Promise<GovernanceResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response: GovernanceResponse | undefined) => {
        if (chrome.runtime.lastError) {
          resolve({ action: 'allow' });
          return;
        }
        resolve(response ?? { action: 'allow' });
      });
    } catch {
      resolve({ action: 'allow' });
    }
  });
}

// ---- Copy / Cut monitoring ----

document.addEventListener(
  'copy',
  async (event: ClipboardEvent) => {
    const response = await sendMessage({
      type: 'governance:copy-check',
      tabUrl: location.href,
      data: { sourceDomain: location.hostname },
    });

    if (response.action === 'block') {
      event.preventDefault();
      event.stopImmediatePropagation();
      showWarningOverlay(response.message ?? 'Copy blocked by security policy.');
    } else if (response.action === 'warn') {
      showWarningOverlay(response.message ?? 'Warning: copying content may violate security policy.');
    }
  },
  true, // capture phase
);

document.addEventListener(
  'cut',
  async (event: ClipboardEvent) => {
    const response = await sendMessage({
      type: 'governance:copy-check',
      tabUrl: location.href,
      data: { sourceDomain: location.hostname },
    });

    if (response.action === 'block') {
      event.preventDefault();
      event.stopImmediatePropagation();
      showWarningOverlay(response.message ?? 'Cut blocked by security policy.');
    } else if (response.action === 'warn') {
      showWarningOverlay(response.message ?? 'Warning: cutting content may violate security policy.');
    }
  },
  true, // capture phase
);

// ---- Paste monitoring ----

document.addEventListener(
  'paste',
  async (event: ClipboardEvent) => {
    const clipboardText = event.clipboardData?.getData('text/plain') ?? '';

    const response = await sendMessage({
      type: 'governance:paste-check',
      tabUrl: location.href,
      data: {
        targetDomain: location.hostname,
        text: clipboardText.substring(0, 100),
      },
    });

    if (response.action === 'block') {
      event.preventDefault();
      event.stopImmediatePropagation();
      showWarningOverlay(response.message ?? 'Paste blocked by security policy.');
    } else if (response.action === 'warn') {
      showWarningOverlay(response.message ?? 'Warning: pasting content may violate security policy.');
    }
  },
  true, // capture phase
);

})();
