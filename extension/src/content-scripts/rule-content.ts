/**
 * Rule Engine Content Script -- injected into all pages.
 *
 * Evaluates Phoenix rules in page context: checks DOM conditions,
 * sets up triggers, and executes actions. Communicates with the
 * service worker via chrome.runtime.sendMessage.
 *
 * This file must be fully self-contained: NO imports from extension modules.
 */

((): void => {

// ---- Inline types (mirrors of rules.ts) ----

interface RuleTrigger {
  type: 'page_load' | 'dom_mutation' | 'form_submit' | 'click' | 'interval' | 'url_change' | 'clipboard' | 'input_submit';
  selector?: string;
  ms?: number;
  direction?: 'copy' | 'paste' | 'both';
}

interface DomCondition {
  type: 'element_exists' | 'element_absent' | 'element_count' | 'element_text_matches' | 'element_attr_matches' | 'page_text_matches';
  selector?: string;
  pattern?: string;
  attribute?: string;
  operator?: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  value?: number;
}

interface RuleMatch {
  domains?: string[];
  url_patterns?: string[];
  url_regex?: string[];
  exclude_domains?: string[];
  trigger: RuleTrigger;
  dom_conditions?: DomCondition[];
}

interface RuleAction {
  type: string;
  params: Record<string, string | number | boolean>;
}

interface PhoenixRule {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  severity: string;
  author: string;
  tags: string[];
  match: RuleMatch;
  actions: RuleAction[];
  run_once_per_page: boolean;
  cooldown_ms: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

// ---- sendMessage helper ----

function sendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response: Record<string, unknown> | undefined) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        resolve(response ?? {});
      });
    } catch {
      // Extension context invalidated
      resolve({});
    }
  });
}

// ---- ConditionEvaluator ----

function evaluateConditions(conditions: DomCondition[]): boolean {
  for (const cond of conditions) {
    if (!evaluateSingleCondition(cond)) return false;
  }
  return true;
}

function evaluateSingleCondition(cond: DomCondition): boolean {
  switch (cond.type) {
    case 'element_exists': {
      if (!cond.selector) return false;
      return document.querySelectorAll(cond.selector).length > 0;
    }

    case 'element_absent': {
      if (!cond.selector) return false;
      return document.querySelectorAll(cond.selector).length === 0;
    }

    case 'element_count': {
      if (!cond.selector || cond.value === undefined || !cond.operator) return false;
      const count = document.querySelectorAll(cond.selector).length;
      return compareOp(count, cond.operator, cond.value);
    }

    case 'element_text_matches': {
      if (!cond.selector || !cond.pattern) return false;
      const regex = safeRegex(cond.pattern);
      if (!regex) return false;
      const els = document.querySelectorAll(cond.selector);
      console.log(`[PhoenixRules] element_text_matches: selector="${cond.selector}" pattern="${cond.pattern}" found=${els.length} elements`);
      for (let i = 0; i < els.length; i++) {
        const text = els[i].textContent || '';
        console.log(`[PhoenixRules]   el[${i}] text="${text.substring(0, 200)}" matches=${regex.test(text)}`);
        if (regex.test(text)) return true;
      }
      return false;
    }

    case 'element_attr_matches': {
      if (!cond.selector || !cond.attribute || !cond.pattern) return false;
      const regex = safeRegex(cond.pattern);
      if (!regex) return false;
      const els = document.querySelectorAll(cond.selector);
      for (let i = 0; i < els.length; i++) {
        const attrVal = els[i].getAttribute(cond.attribute) || '';
        if (regex.test(attrVal)) return true;
      }
      return false;
    }

    case 'page_text_matches': {
      if (!cond.pattern) return false;
      const regex = safeRegex(cond.pattern);
      if (!regex) return false;
      // Limit to first 100KB of page text
      const pageText = (document.body?.innerText || '').substring(0, 102_400);
      const result = regex.test(pageText);
      console.log(`[PhoenixRules] page_text_matches: pattern="${cond.pattern}" pageTextLen=${pageText.length} matches=${result}`);
      if (!result) {
        // Log nearby text around input areas for debugging
        const inputs = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], .ProseMirror');
        for (let i = 0; i < inputs.length; i++) {
          console.log(`[PhoenixRules]   input[${i}] textContent="${(inputs[i].textContent || '').substring(0, 200)}"`);
        }
      }
      return result;
    }

    default:
      return false;
  }
}

function compareOp(actual: number, op: string, expected: number): boolean {
  switch (op) {
    case 'gt': return actual > expected;
    case 'lt': return actual < expected;
    case 'eq': return actual === expected;
    case 'gte': return actual >= expected;
    case 'lte': return actual <= expected;
    default: return false;
  }
}

function safeRegex(pattern: string): RegExp | null {
  if (pattern.length > 500) return null;
  try {
    // Support PCRE-style inline flags like (?i), (?im), (?is) at start of pattern
    let flags = '';
    let pat = pattern;
    const inlineFlags = /^\(\?([gimsuy]+)\)/.exec(pat);
    if (inlineFlags) {
      flags = inlineFlags[1];
      pat = pat.slice(inlineFlags[0].length);
    }
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

// ---- ActionExecutor ----

function executeAction(action: RuleAction, rule: PhoenixRule): void {
  const params = action.params;
  const selector = String(params.selector || '');

  switch (action.type) {
    case 'hide_element': {
      if (!selector) break;
      const els = document.querySelectorAll<HTMLElement>(selector);
      els.forEach((el) => { el.style.display = 'none'; });
      break;
    }

    case 'remove_element': {
      if (!selector) break;
      const els = document.querySelectorAll(selector);
      els.forEach((el) => el.remove());
      break;
    }

    case 'add_overlay': {
      const overlayId = `phoenix-overlay-${rule.id}`;
      if (document.getElementById(overlayId)) break;
      const overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.className = 'phoenix-rule-overlay';
      overlay.setAttribute('style', [
        'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
        `background:${String(params.background || 'rgba(0,0,0,0.7)')}`,
        'z-index:2147483646', 'display:flex', 'align-items:center', 'justify-content:center',
        'font-family:system-ui,sans-serif', 'color:#fff', 'font-size:18px',
      ].join(';'));
      overlay.textContent = String(params.message || 'Access restricted by security policy');
      if (selector) {
        const target = document.querySelector<HTMLElement>(selector);
        if (target) {
          overlay.style.position = 'absolute';
          const rect = target.getBoundingClientRect();
          overlay.style.top = `${rect.top + window.scrollY}px`;
          overlay.style.left = `${rect.left + window.scrollX}px`;
          overlay.style.width = `${rect.width}px`;
          overlay.style.height = `${rect.height}px`;
        }
      }
      document.body.appendChild(overlay);
      break;
    }

    case 'highlight_element': {
      if (!selector) break;
      const color = String(params.color || '#ff0000');
      const els = document.querySelectorAll<HTMLElement>(selector);
      els.forEach((el) => { el.style.outline = `3px solid ${color}`; });
      break;
    }

    case 'set_attribute': {
      if (!selector || !params.attribute) break;
      const els = document.querySelectorAll(selector);
      els.forEach((el) => el.setAttribute(String(params.attribute), String(params.value ?? '')));
      break;
    }

    case 'add_class': {
      if (!selector || !params.class) break;
      const els = document.querySelectorAll(selector);
      els.forEach((el) => el.classList.add(String(params.class)));
      break;
    }

    case 'block_form_submit': {
      const formSelector = selector || 'form';
      const forms = document.querySelectorAll<HTMLFormElement>(formSelector);
      forms.forEach((form) => {
        form.addEventListener('submit', (e: Event) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        }, { capture: true });
      });
      break;
    }

    case 'block_click': {
      if (!selector) break;
      const els = document.querySelectorAll(selector);
      els.forEach((el) => {
        el.addEventListener('click', (e: Event) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        }, { capture: true });
      });
      break;
    }

    case 'block_navigation': {
      window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
        e.preventDefault();
        // Modern browsers require returnValue to be set
        e.returnValue = String(params.message || 'Navigation blocked by security policy');
      });
      break;
    }

    case 'log_event': {
      sendMessage({
        type: 'rules:extract',
        ruleId: rule.id,
        ruleName: rule.name,
        url: location.href,
        data: {
          logType: 'log_event',
          message: String(params.message || ''),
          timestamp: Date.now(),
        },
      });
      break;
    }

    case 'alert': {
      const alertTitle = String(params.title || rule.name);
      const alertMsg = String(params.message || `Rule "${rule.name}" triggered`);
      const severity = rule.severity || 'high';

      // Remove any existing Phoenix alert modal
      const existing = document.getElementById('phoenix-shield-modal');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'phoenix-shield-modal';
      overlay.style.cssText = `
        position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);animation:phoenixFadeIn 0.2s ease-out;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      `;

      const accentColor = severity === 'critical' ? '#dc2626' : severity === 'high' ? '#ea580c' : '#d97706';

      overlay.innerHTML = `
        <style>
          @keyframes phoenixFadeIn { from { opacity:0; } to { opacity:1; } }
          @keyframes phoenixSlideIn { from { opacity:0; transform:scale(0.95) translateY(10px); } to { opacity:1; transform:scale(1) translateY(0); } }
          @keyframes phoenixPulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }
        </style>
        <div style="
          background:#111;border:1px solid ${accentColor}44;border-radius:16px;padding:0;max-width:480px;width:90%;
          box-shadow:0 0 60px ${accentColor}33,0 0 0 1px ${accentColor}22,0 25px 50px rgba(0,0,0,0.5);
          animation:phoenixSlideIn 0.3s ease-out;overflow:hidden;
        ">
          <div style="background:${accentColor};padding:3px 0;"></div>
          <div style="padding:28px 32px 24px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
              <div style="
                width:44px;height:44px;border-radius:12px;background:${accentColor}18;border:1px solid ${accentColor}44;
                display:flex;align-items:center;justify-content:center;flex-shrink:0;
              ">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                </svg>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:${accentColor};margin-bottom:2px;animation:phoenixPulse 2s infinite;">
                  ${severity.toUpperCase()} THREAT BLOCKED
                </div>
                <div style="font-size:17px;font-weight:600;color:#f1f1f1;line-height:1.3;">
                  ${alertTitle}
                </div>
              </div>
            </div>
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:14px 16px;margin-bottom:20px;">
              <div style="font-size:13px;color:#ccc;line-height:1.6;">
                ${alertMsg}
              </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="width:8px;height:8px;border-radius:50%;background:${accentColor};animation:phoenixPulse 1.5s infinite;"></div>
                <span style="font-size:11px;color:#888;font-weight:500;">Phoenix Shield | Incident Logged</span>
              </div>
              <button id="phoenix-shield-dismiss" style="
                background:${accentColor};color:#fff;border:none;border-radius:8px;padding:8px 20px;
                font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;
              ">Dismiss</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const dismissBtn = document.getElementById('phoenix-shield-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => overlay.remove());
        dismissBtn.addEventListener('mouseover', () => { dismissBtn.style.filter = 'brightness(1.15)'; });
        dismissBtn.addEventListener('mouseout', () => { dismissBtn.style.filter = ''; });
      }
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      // Auto-dismiss after 15 seconds
      setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 15000);
      break;
    }

    case 'extract_data': {
      if (!selector) break;
      const els = document.querySelectorAll(selector);
      const extracted: Array<{ text: string; attributes: Record<string, string> }> = [];
      els.forEach((el) => {
        const attrs: Record<string, string> = {};
        if (params.attributes) {
          const attrNames = String(params.attributes).split(',');
          attrNames.forEach((name) => {
            const trimmed = name.trim();
            attrs[trimmed] = el.getAttribute(trimmed) || '';
          });
        }
        extracted.push({
          text: (el.textContent || '').substring(0, 4096),
          attributes: attrs,
        });
      });
      sendMessage({
        type: 'rules:extract',
        ruleId: rule.id,
        ruleName: rule.name,
        url: location.href,
        data: { extracted },
      });
      break;
    }

    case 'inject_banner': {
      const bannerId = `phoenix-banner-${rule.id}`;
      if (document.getElementById(bannerId)) break;
      const banner = document.createElement('div');
      banner.id = bannerId;
      banner.className = 'phoenix-rule-banner';
      const position = String(params.position || 'top');
      banner.setAttribute('style', [
        'position:fixed',
        position === 'bottom' ? 'bottom:0' : 'top:0',
        'left:0', 'width:100%', 'padding:12px 20px',
        `background:${String(params.background || '#dc2626')}`,
        `color:${String(params.color || '#fff')}`,
        'font-family:system-ui,sans-serif', 'font-size:14px', 'font-weight:600',
        'text-align:center', 'z-index:2147483647',
        'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      ].join(';'));
      banner.textContent = String(params.message || 'Security notice');
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '\u00d7';
      closeBtn.setAttribute('style', [
        'position:absolute', 'right:12px', 'top:50%', 'transform:translateY(-50%)',
        'background:none', 'border:none', 'color:inherit', 'font-size:20px',
        'cursor:pointer', 'padding:0 4px',
      ].join(';'));
      closeBtn.addEventListener('click', () => banner.remove());
      banner.appendChild(closeBtn);
      document.body.appendChild(banner);
      break;
    }

    case 'inject_tooltip': {
      if (!selector) break;
      const els = document.querySelectorAll<HTMLElement>(selector);
      els.forEach((el) => {
        const tooltipId = `phoenix-tooltip-${rule.id}`;
        if (el.querySelector(`.${tooltipId}`)) return;
        const tooltip = document.createElement('div');
        tooltip.className = `phoenix-rule-tooltip ${tooltipId}`;
        tooltip.setAttribute('style', [
          'position:absolute', 'top:-32px', 'left:0',
          `background:${String(params.background || '#1f2937')}`,
          `color:${String(params.color || '#fff')}`,
          'padding:4px 10px', 'border-radius:4px', 'font-size:12px',
          'font-family:system-ui,sans-serif', 'white-space:nowrap',
          'pointer-events:none', 'z-index:2147483645',
        ].join(';'));
        tooltip.textContent = String(params.message || 'Policy notice');
        el.style.position = el.style.position || 'relative';
        el.appendChild(tooltip);
      });
      break;
    }

    case 'redirect': {
      // Delegate to service worker (needs chrome.tabs.update)
      sendMessage({
        type: 'rules:matched',
        rule: { id: rule.id, name: rule.name, severity: rule.severity, trigger: rule.match.trigger.type },
        action: { type: 'redirect', params },
        url: location.href,
      });
      break;
    }

    case 'close_tab': {
      sendMessage({
        type: 'rules:matched',
        rule: { id: rule.id, name: rule.name, severity: rule.severity, trigger: rule.match.trigger.type },
        action: { type: 'close_tab', params },
        url: location.href,
      });
      break;
    }

    case 'notify': {
      sendMessage({
        type: 'rules:matched',
        rule: { id: rule.id, name: rule.name, severity: rule.severity, trigger: rule.match.trigger.type },
        action: { type: 'notify', params },
        url: location.href,
      });
      break;
    }

    default:
      break;
  }
}

// ---- TriggerManager ----

// Shared state for cleanup
const cleanupFns: Array<() => void> = [];
let sharedObserver: MutationObserver | null = null;
const mutationCallbacks: Array<(mutations: MutationRecord[]) => void> = [];

function setupTriggers(rules: PhoenixRule[]): void {
  console.log(`[PhoenixRules] Setting up triggers for ${rules.length} rules`);
  for (const rule of rules) {
    console.log(`[PhoenixRules] Setting up trigger "${rule.match.trigger.type}" for rule: ${rule.name}`);
    setupTriggerForRule(rule);
  }

  // Start shared MutationObserver if any rule needs it
  if (mutationCallbacks.length > 0 && !sharedObserver) {
    sharedObserver = new MutationObserver((mutations) => {
      for (const cb of mutationCallbacks) {
        try { cb(mutations); } catch { /* ignore */ }
      }
    });
    sharedObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    cleanupFns.push(() => {
      if (sharedObserver) {
        sharedObserver.disconnect();
        sharedObserver = null;
      }
    });
  }
}

function setupTriggerForRule(rule: PhoenixRule): void {
  const trigger = rule.match.trigger;

  switch (trigger.type) {
    case 'page_load': {
      // Execute immediately (we are at document_idle)
      fireRule(rule);
      break;
    }

    case 'dom_mutation': {
      const cb = (mutations: MutationRecord[]): void => {
        if (trigger.selector) {
          // Check if any added node matches the selector
          let matched = false;
          for (const mutation of mutations) {
            for (let i = 0; i < mutation.addedNodes.length; i++) {
              const node = mutation.addedNodes[i];
              if (!(node instanceof HTMLElement)) continue;
              if (node.matches(trigger.selector) || node.querySelector(trigger.selector)) {
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
          if (!matched) return;
        }
        fireRule(rule);
      };
      mutationCallbacks.push(cb);
      cleanupFns.push(() => {
        const idx = mutationCallbacks.indexOf(cb);
        if (idx !== -1) mutationCallbacks.splice(idx, 1);
      });
      break;
    }

    case 'form_submit': {
      const handler = (e: Event): void => {
        if (trigger.selector) {
          const form = e.target as HTMLElement;
          if (!form.matches(trigger.selector)) return;
        }
        fireRule(rule);
      };
      document.addEventListener('submit', handler, { capture: true });
      cleanupFns.push(() => document.removeEventListener('submit', handler, { capture: true }));
      break;
    }

    case 'click': {
      const handler = (e: Event): void => {
        if (trigger.selector) {
          const target = e.target as HTMLElement;
          if (!target.matches(trigger.selector) && !target.closest(trigger.selector)) return;
        }
        fireRule(rule);
      };
      document.addEventListener('click', handler, { capture: true });
      cleanupFns.push(() => document.removeEventListener('click', handler, { capture: true }));
      break;
    }

    case 'interval': {
      const ms = Math.max(trigger.ms || 5000, 1000); // Floor at 1s
      const intervalId = setInterval(() => fireRule(rule), ms);
      cleanupFns.push(() => clearInterval(intervalId));
      break;
    }

    case 'url_change': {
      let lastUrl = location.href;

      const checkUrlChange = (): void => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          fireRule(rule);
        }
      };

      // Listen for popstate
      window.addEventListener('popstate', checkUrlChange);
      cleanupFns.push(() => window.removeEventListener('popstate', checkUrlChange));

      // Intercept pushState / replaceState
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      history.pushState = function (...args: Parameters<typeof history.pushState>) {
        origPush(...args);
        checkUrlChange();
      };
      history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
        origReplace(...args);
        checkUrlChange();
      };
      cleanupFns.push(() => {
        history.pushState = origPush;
        history.replaceState = origReplace;
      });
      break;
    }

    case 'clipboard': {
      const direction = trigger.direction || 'both';
      if (direction === 'copy' || direction === 'both') {
        const handler = (): void => { fireRule(rule); };
        document.addEventListener('copy', handler, { capture: true });
        cleanupFns.push(() => document.removeEventListener('copy', handler, { capture: true }));
      }
      if (direction === 'paste' || direction === 'both') {
        const handler = (): void => { fireRule(rule); };
        document.addEventListener('paste', handler, { capture: true });
        cleanupFns.push(() => document.removeEventListener('paste', handler, { capture: true }));
      }
      break;
    }

    case 'input_submit': {
      // Special composite trigger for AI chat apps
      // Monitors input fields in real-time and also catches submit actions
      const inputSelectors = trigger.selector || 'textarea, [contenteditable="true"], [role="textbox"]';
      const sendButtonSelectors = 'button[type="submit"], button[data-testid*="send"], button[aria-label*="send" i], button[aria-label*="Send" i]';
      console.log(`[PhoenixRules] input_submit trigger setup. inputSelectors="${inputSelectors}", sendBtnSelectors="${sendButtonSelectors}"`);

      // Real-time input monitoring: fire as soon as conditions match while typing
      const inputHandler = (e: Event): void => {
        const target = e.target as HTMLElement;
        if (!target) return;
        const isInput = target.matches?.(inputSelectors) || !!target.closest?.(inputSelectors);
        if (!isInput) return;
        console.log(`[PhoenixRules] input_submit: input event on`, target.tagName, `firing rule check: ${rule.name}`);
        fireRule(rule);
      };
      document.addEventListener('input', inputHandler, { capture: true });
      cleanupFns.push(() => document.removeEventListener('input', inputHandler, { capture: true }));

      // Paste event monitoring: pasted content appears in DOM after a short delay
      const pasteHandler = (e: Event): void => {
        const target = e.target as HTMLElement;
        if (!target) return;
        const isInput = target.matches?.(inputSelectors) || !!target.closest?.(inputSelectors);
        if (!isInput) return;
        // Check immediately and after delays to catch async paste rendering
        console.log(`[PhoenixRules] input_submit: paste event, scheduling checks for: ${rule.name}`);
        setTimeout(() => fireRule(rule), 0);
        setTimeout(() => fireRule(rule), 50);
        setTimeout(() => fireRule(rule), 200);
      };
      document.addEventListener('paste', pasteHandler, { capture: true });
      cleanupFns.push(() => document.removeEventListener('paste', pasteHandler, { capture: true }));

      // Also observe contenteditable/ProseMirror via MutationObserver as fallback
      // (some editors don't fire standard input events)
      const observeInputFields = (): void => {
        const fields = document.querySelectorAll(inputSelectors);
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];
          if ((field as HTMLElement).dataset?.phoenixObserved) continue;
          (field as HTMLElement).dataset.phoenixObserved = '1';
          const mo = new MutationObserver(() => {
            console.log(`[PhoenixRules] input_submit: MutationObserver on`, field.tagName, `firing rule check: ${rule.name}`);
            fireRule(rule);
          });
          mo.observe(field, { childList: true, characterData: true, subtree: true });
          cleanupFns.push(() => mo.disconnect());
        }
      };
      // Observe now and re-scan periodically for dynamically added fields
      observeInputFields();
      const scanInterval = setInterval(observeInputFields, 2000);
      cleanupFns.push(() => clearInterval(scanInterval));

      // Enter key on input elements
      const keyHandler = ((e: KeyboardEvent): void => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        const target = e.target as HTMLElement;
        if (!target.matches(inputSelectors)) return;
        console.log(`[PhoenixRules] input_submit: Enter key submit! Firing rule: ${rule.name}`);
        fireRule(rule);
      }) as EventListener;
      document.addEventListener('keydown', keyHandler, { capture: true });
      cleanupFns.push(() => document.removeEventListener('keydown', keyHandler, { capture: true }));

      // Click on send buttons (handle SVG elements inside buttons)
      const clickHandler = (e: Event): void => {
        let node: Node | null = e.target as Node;
        while (node && !(node instanceof HTMLElement)) {
          node = node.parentNode;
        }
        if (!node) return;
        const target = node as HTMLElement;
        if (!target.matches(sendButtonSelectors) && !target.closest(sendButtonSelectors)) return;
        console.log(`[PhoenixRules] input_submit: Send button clicked! Firing rule: ${rule.name}`);
        fireRule(rule);
      };
      document.addEventListener('click', clickHandler, { capture: true });
      cleanupFns.push(() => document.removeEventListener('click', clickHandler, { capture: true }));
      break;
    }

    default:
      break;
  }
}

// ---- RuleManager ----

const firedRules = new Set<string>();
const cooldowns = new Map<string, number>();

function fireRule(rule: PhoenixRule): void {
  console.log(`[PhoenixRules] fireRule called for: ${rule.name}`);

  // Check run_once_per_page
  if (rule.run_once_per_page && firedRules.has(rule.id)) {
    console.log(`[PhoenixRules] Rule "${rule.name}" already fired (run_once_per_page)`);
    return;
  }

  // Check cooldown
  const now = Date.now();
  if (rule.cooldown_ms > 0) {
    const lastFired = cooldowns.get(rule.id) || 0;
    if (now - lastFired < rule.cooldown_ms) return;
  }

  // Evaluate DOM conditions
  const conditions = rule.match.dom_conditions || [];
  if (conditions.length > 0) {
    console.log(`[PhoenixRules] Evaluating ${conditions.length} DOM conditions for "${rule.name}":`, JSON.stringify(conditions));
    const condResult = evaluateConditions(conditions);
    console.log(`[PhoenixRules] DOM conditions result for "${rule.name}": ${condResult}`);
    if (!condResult) return;
  }

  // Mark as fired
  firedRules.add(rule.id);
  cooldowns.set(rule.id, now);

  // Capture user input before actions clear it
  const inputSelectors = rule.match.trigger.selector || 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor, .tiptap';
  let capturedInput = '';
  try {
    const inputs = document.querySelectorAll(inputSelectors);
    for (let i = 0; i < inputs.length; i++) {
      const text = (inputs[i].textContent || '').trim();
      if (text) { capturedInput = text.substring(0, 500); break; }
    }
  } catch { /* ignore */ }

  // Execute all actions
  for (const action of rule.actions) {
    try {
      executeAction(action, rule);
    } catch {
      // Ignore action errors to not break other actions
    }
  }

  // Notify service worker ONCE that rule was matched (with captured input)
  sendMessage({
    type: 'rules:matched',
    rule: {
      id: rule.id,
      name: rule.name,
      severity: rule.severity,
      trigger: rule.match.trigger.type,
    },
    action: { type: 'matched', params: {} },
    url: location.href,
    userInput: capturedInput,
  });
}

function cleanup(): void {
  for (const fn of cleanupFns) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupFns.length = 0;
  mutationCallbacks.length = 0;
  firedRules.clear();
  cooldowns.clear();
  sharedObserver = null;
}

// ---- Initialize ----

async function init(): Promise<void> {
  console.log('[PhoenixRules] init() called for URL:', location.href);

  const response = await sendMessage({
    type: 'rules:get',
    url: location.href,
  });

  console.log('[PhoenixRules] Response from service worker:', JSON.stringify(response).substring(0, 500));

  const rules = (response as { rules?: PhoenixRule[] }).rules;
  if (!rules || rules.length === 0) {
    console.log('[PhoenixRules] No rules received for this URL. Response keys:', Object.keys(response));
    return;
  }

  console.log(`[PhoenixRules] Received ${rules.length} rules:`, rules.map(r => `${r.name} (trigger: ${r.match.trigger.type})`));
  setupTriggers(rules);
}

// Start rule engine
console.log('[PhoenixRules] Content script loaded on:', location.hostname);
init();

// Listen for hot-reload signals from service worker when rules are updated
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'rules:refresh') {
    console.log('[PhoenixRules] Received rules:refresh — re-initializing rules');
    cleanup();
    init();
  }
});

// Re-initialize on SPA URL changes
let currentUrl = location.href;
const urlCheckObserver = new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    cleanup();
    init();
  }
});
urlCheckObserver.observe(document.documentElement, { childList: true, subtree: true });
cleanupFns.push(() => urlCheckObserver.disconnect());

})();
