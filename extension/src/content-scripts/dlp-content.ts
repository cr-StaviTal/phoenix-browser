/**
 * DLP Content Script -- injected into all pages.
 *
 * Watches for file-input elements, paste events, and sensitive data in form
 * fields.  Communicates with the service worker via chrome.runtime.sendMessage.
 *
 * This file must be fully self-contained: NO imports from extension modules.
 */

((): void => {

// ---- Local types (mirrors of messages.ts, kept inline) ----

interface DlpMessage {
  type: 'dlp:file-input-detected' | 'dlp:paste-detected' | 'dlp:sensitive-data-found';
  tabUrl: string;
  data: Record<string, unknown>;
}

interface DlpResponse {
  action: 'allow' | 'block' | 'warn';
  message?: string;
}

// ---- Sensitive data patterns (lightweight client-side check) ----

const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/;
const CC_RE = /\b(?:\d[ -]*?){13,19}\b/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

// ---- Warning overlay ----

function showWarningOverlay(message: string): void {
  // Avoid duplicates
  const existing = document.getElementById('phoenix-dlp-warning');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'phoenix-dlp-warning';
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

// ---- Helpers ----

function sendMessage(msg: DlpMessage): Promise<DlpResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response: DlpResponse | undefined) => {
        if (chrome.runtime.lastError) {
          // Extension context invalidated (e.g., after reload)
          resolve({ action: 'allow' });
          return;
        }
        resolve(response ?? { action: 'allow' });
      });
    } catch {
      // Extension context invalidated
      resolve({ action: 'allow' });
    }
  });
}

// ---- File input monitoring ----

function attachFileListener(input: HTMLInputElement): void {
  if ((input as unknown as Record<string, boolean>).__phoenixDlp) return;
  (input as unknown as Record<string, boolean>).__phoenixDlp = true;

  input.addEventListener('change', async () => {
    const files = input.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const response = await sendMessage({
        type: 'dlp:file-input-detected',
        tabUrl: location.href,
        data: { fileName: file.name, fileSize: file.size },
      });

      if (response.action === 'block') {
        // Clear the file input
        input.value = '';

        // Prevent form submission
        const form = input.closest('form');
        if (form) {
          form.addEventListener(
            'submit',
            (e) => {
              e.preventDefault();
              e.stopImmediatePropagation();
            },
            { once: true, capture: true },
          );
        }

        showWarningOverlay(response.message ?? 'This file upload has been blocked by security policy.');
        break;
      } else if (response.action === 'warn') {
        showWarningOverlay(response.message ?? 'Warning: this file upload may violate security policy.');
      }
    }
  });
}

function scanForFileInputs(root: ParentNode): void {
  const inputs = root.querySelectorAll<HTMLInputElement>('input[type="file"]');
  inputs.forEach(attachFileListener);
}

// ---- Paste monitoring ----

document.addEventListener(
  'paste',
  async (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;

    const response = await sendMessage({
      type: 'dlp:paste-detected',
      tabUrl: location.href,
      data: { text: text.substring(0, 4096) },
    });

    if (response.action === 'block') {
      event.preventDefault();
      showWarningOverlay(response.message ?? 'Paste blocked: sensitive data detected.');
    } else if (response.action === 'warn') {
      showWarningOverlay(response.message ?? 'Warning: pasted content may contain sensitive data.');
    }
  },
  true, // capture phase
);

// ---- Periodic sensitive-data scan on visible fields ----

let scanTimeout: ReturnType<typeof setTimeout> | null = null;

function scanVisibleFields(): void {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type="hidden"]):not([type="password"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea',
  );

  fields.forEach((field) => {
    const value = field.value;
    if (!value || value.length < 5) return;

    let dataType: string | null = null;
    if (SSN_RE.test(value)) dataType = 'ssn';
    else if (CC_RE.test(value)) dataType = 'credit_card';
    else if (EMAIL_RE.test(value)) dataType = 'email';

    if (dataType) {
      // Only process once per field per data type
      const flagKey = `__phoenixDlpWarned_${dataType}`;
      if ((field as unknown as Record<string, boolean>)[flagKey]) return;
      (field as unknown as Record<string, boolean>)[flagKey] = true;

      const isHighRisk = dataType === 'ssn' || dataType === 'credit_card';

      // Visual indicator: red border
      field.style.outline = '2px solid #ef4444';
      field.style.outlineOffset = '1px';

      // Tooltip label next to field
      const existingLabel = field.parentElement?.querySelector('.phoenix-dlp-label');
      if (!existingLabel) {
        const label = document.createElement('span');
        label.className = 'phoenix-dlp-label';
        label.textContent = isHighRisk
          ? `BLOCKED: Sensitive data (${dataType.toUpperCase()}) - field cleared`
          : `Sensitive data detected (${dataType.toUpperCase()})`;
        label.setAttribute(
          'style',
          [
            'display:inline-block',
            'margin-left:6px',
            'padding:2px 8px',
            isHighRisk ? 'background:#ef4444' : 'background:#fef2f2',
            isHighRisk ? 'color:#fff' : 'color:#b91c1c',
            isHighRisk ? 'border:1px solid #dc2626' : 'border:1px solid #fca5a5',
            'border-radius:4px',
            'font-size:11px',
            'font-family:system-ui,sans-serif',
            'font-weight:600',
            'vertical-align:middle',
            'pointer-events:none',
            'z-index:999999',
          ].join(';'),
        );
        field.insertAdjacentElement('afterend', label);
      }

      // For high-risk data (SSN, CC): clear the field and block submission
      if (isHighRisk) {
        // Clear the sensitive data from the field
        field.value = '';
        field.style.outline = '3px solid #ef4444';

        // Block form submission for this form
        const form = field.closest('form');
        if (form && !(form as unknown as Record<string, boolean>).__phoenixDlpBlocked) {
          (form as unknown as Record<string, boolean>).__phoenixDlpBlocked = true;

          // Block submit event
          form.addEventListener('submit', (e: Event) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            showWarningOverlay('Form submission blocked: sensitive data (SSN/Credit Card) was detected. The data has been removed for your protection.');
          }, { capture: true });
        }

        // Block Enter key on this field
        field.addEventListener('keydown', ((e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopImmediatePropagation();
            showWarningOverlay('Submission blocked: this field contained sensitive data.');
          }
        }) as EventListener, { capture: true });

        showWarningOverlay(
          `Sensitive data (${dataType.toUpperCase()}) was detected and removed from the form field. Submission has been blocked to protect your data.`
        );
      }

      sendMessage({
        type: 'dlp:sensitive-data-found',
        tabUrl: location.href,
        data: {
          dataType,
          fieldName: field.name || field.id || field.placeholder || 'unknown',
        },
      });
    }
  });
}

function scheduleScan(): void {
  if (scanTimeout !== null) return; // debounce
  scanTimeout = setTimeout(() => {
    scanTimeout = null;
    scanVisibleFields();
    scheduleScan(); // reschedule
  }, 2000);
}

// ---- MutationObserver for dynamically added file inputs ----

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (let i = 0; i < mutation.addedNodes.length; i++) {
      const node = mutation.addedNodes[i];
      if (!(node instanceof HTMLElement)) continue;

      if (
        node instanceof HTMLInputElement &&
        node.type === 'file'
      ) {
        attachFileListener(node);
      } else {
        scanForFileInputs(node);
      }
    }
  }
});

// ---- Initialize ----

scanForFileInputs(document);
observer.observe(document.documentElement, { childList: true, subtree: true });
scheduleScan();

})();
