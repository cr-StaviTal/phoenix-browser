/**
 * Form Content Script -- injected into all pages.
 *
 * Monitors form submissions that include password fields and detects password
 * inputs added dynamically.  Communicates with the service worker via
 * chrome.runtime.sendMessage.
 *
 * This file must be fully self-contained: NO imports from extension modules.
 */

((): void => {

// ---- Local types ----

interface FormMessage {
  type: 'form:submission-detected' | 'form:password-field-detected';
  tabUrl: string;
  data: Record<string, unknown>;
}

// ---- Warning overlay ----

function showWarningOverlay(message: string): void {
  const existing = document.getElementById('phoenix-form-warning');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'phoenix-form-warning';
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

  setTimeout(() => overlay.remove(), 10_000);
}

// ---- Helpers ----

function sendMessage(msg: FormMessage): void {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* context invalidated */ }
    });
  } catch {
    // Extension context invalidated
  }
}

function getFormAction(form: HTMLFormElement): string {
  try {
    return form.action || form.getAttribute('action') || location.href;
  } catch {
    return location.href;
  }
}

function countInputs(form: HTMLFormElement): number {
  return form.querySelectorAll('input').length;
}

// ---- Form submission monitoring (capture phase) ----

document.addEventListener(
  'submit',
  (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    if (!form || !(form instanceof HTMLFormElement)) return;

    const passwordFields = form.querySelectorAll('input[type="password"]');
    if (passwordFields.length === 0) return;

    // NEVER send actual credentials -- only metadata
    sendMessage({
      type: 'form:submission-detected',
      tabUrl: location.href,
      data: {
        formAction: getFormAction(form),
        hasPassword: true,
        isHTTPS: location.protocol === 'https:',
        inputCount: countInputs(form),
      },
    });
  },
  true, // capture phase
);

// ---- Password field detection ----

function handlePasswordField(input: HTMLInputElement): void {
  if ((input as unknown as Record<string, boolean>).__phoenixFormTracked) return;
  (input as unknown as Record<string, boolean>).__phoenixFormTracked = true;

  const form = input.closest('form');
  const formAction = form ? getFormAction(form) : location.href;
  const isHTTPS = location.protocol === 'https:';

  sendMessage({
    type: 'form:password-field-detected',
    tabUrl: location.href,
    data: {
      formAction,
      isHTTPS,
    },
  });

  if (!isHTTPS) {
    showWarningOverlay(
      'This page is not secure. Your password could be visible to others on the network.',
    );
  }
}

function scanForPasswordFields(root: ParentNode): void {
  const fields = root.querySelectorAll<HTMLInputElement>('input[type="password"]');
  fields.forEach(handlePasswordField);
}

// ---- MutationObserver for dynamically added password fields ----

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (let i = 0; i < mutation.addedNodes.length; i++) {
      const node = mutation.addedNodes[i];
      if (!(node instanceof HTMLElement)) continue;

      if (
        node instanceof HTMLInputElement &&
        node.type === 'password'
      ) {
        handlePasswordField(node);
      } else {
        scanForPasswordFields(node);
      }
    }
  }
});

// ---- Initialize ----

scanForPasswordFields(document);
observer.observe(document.documentElement, { childList: true, subtree: true });

})();
