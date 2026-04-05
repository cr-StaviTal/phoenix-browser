import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { EventTypes, DlpPayload } from '../types/events';
import { ContentMessage, ContentResponse } from '../types/messages';
import { DlpPolicy } from '../types/policy';

// ---- Sensitive-data pattern definitions ----

interface PatternDef {
  name: string;
  dataType: 'ssn' | 'credit_card' | 'email' | 'custom';
  regex: RegExp;
  validate?: (match: string) => boolean;
}

/** Luhn algorithm for credit-card number validation. */
function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(nums) || nums.length < 13 || nums.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let digit = parseInt(nums[i], 10);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** SSN area-number validator (excludes 000, 666, 900-999). */
function validateSsn(match: string): boolean {
  const digits = match.replace(/-/g, '');
  if (digits.length !== 9) return false;
  const area = parseInt(digits.substring(0, 3), 10);
  if (area === 0 || area === 666 || area >= 900) return false;
  const group = parseInt(digits.substring(3, 5), 10);
  if (group === 0) return false;
  const serial = parseInt(digits.substring(5), 10);
  if (serial === 0) return false;
  return true;
}

const BUILT_IN_PATTERNS: PatternDef[] = [
  {
    name: 'SSN',
    dataType: 'ssn',
    regex: /\b\d{3}-?\d{2}-?\d{4}\b/g,
    validate: validateSsn,
  },
  {
    name: 'Credit Card',
    dataType: 'credit_card',
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (m) => luhnCheck(m),
  },
  {
    name: 'Email',
    dataType: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

// ---- Module ----

export class DlpEngine implements PhoenixModule {
  readonly id = 'dlp-engine';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private messageListener:
    | ((
        message: ContentMessage,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: ContentResponse) => void,
      ) => boolean | void)
    | null = null;

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    this.messageListener = (message, sender, sendResponse) => {
      if (!message?.type?.startsWith('dlp:')) return false; // not ours

      const tabId = sender.tab?.id ?? -1;

      // Handle asynchronously but return true so the message channel stays open
      this.handleContentMessage(message, tabId)
        .then(sendResponse)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errors.push(`DLP message handler error: ${msg}`);
          sendResponse({ action: 'allow' });
        });

      return true; // keep sendResponse channel open for async
    };

    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  destroy(): void {
    this.enabled = false;
    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }
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

  // ---- Public API ----

  /** Scan arbitrary text for sensitive data patterns. Returns all matches. */
  scanText(text: string): Array<{ pattern: string; dataType: string; match: string }> {
    const results: Array<{ pattern: string; dataType: string; match: string }> = [];

    for (const def of BUILT_IN_PATTERNS) {
      // Reset lastIndex for global regexes
      def.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = def.regex.exec(text)) !== null) {
        const candidate = m[0];
        if (def.validate && !def.validate(candidate)) continue;
        results.push({ pattern: def.name, dataType: def.dataType, match: candidate });
      }
    }

    return results;
  }

  // ---- Private ----

  private async handleContentMessage(
    message: ContentMessage,
    tabId: number,
  ): Promise<ContentResponse> {
    this.lastActivity = Date.now();

    switch (message.type) {
      case 'dlp:file-input-detected':
        return this.handleFileUpload(message, tabId);
      case 'dlp:paste-detected':
        return this.handlePaste(message, tabId);
      case 'dlp:sensitive-data-found':
        return this.handleSensitiveData(message, tabId);
      default:
        return { action: 'allow' };
    }
  }

  private async handleFileUpload(
    message: ContentMessage,
    tabId: number,
  ): Promise<ContentResponse> {
    const policy = await this.getPolicy();
    const filePolicy = policy?.file_upload;
    const data = message.data as { fileName?: string; fileSize?: number };
    const fileName = data.fileName ?? '';
    const fileSize = data.fileSize ?? 0;

    let action: 'allow' | 'block' | 'warn' = 'allow';
    let reason = '';

    if (filePolicy) {
      // Check extension
      const ext = fileName.includes('.')
        ? '.' + fileName.split('.').pop()!.toLowerCase()
        : '';
      if (ext && filePolicy.blocked_extensions.includes(ext)) {
        action = 'block';
        reason = `File extension ${ext} is blocked by policy`;
      }

      // Check size
      if (
        action !== 'block' &&
        filePolicy.max_file_size_mb > 0 &&
        fileSize > filePolicy.max_file_size_mb * 1024 * 1024
      ) {
        action = 'block';
        reason = `File exceeds maximum size of ${filePolicy.max_file_size_mb} MB`;
      }

      // Check domain
      if (action !== 'block') {
        try {
          const domain = new URL(message.tabUrl).hostname;
          if (filePolicy.blocked_domains.includes(domain)) {
            action = 'block';
            reason = `File uploads are blocked on ${domain}`;
          }
        } catch {
          // invalid URL, ignore domain check
        }
      }
    }

    this.publishDlpEvent('file_upload', message.tabUrl, tabId, action, {
      fileName,
      fileSize,
    });

    return {
      action,
      message: reason || undefined,
    };
  }

  private async handlePaste(
    message: ContentMessage,
    tabId: number,
  ): Promise<ContentResponse> {
    const policy = await this.getPolicy();
    const data = message.data as { text?: string };
    const text = data.text ?? '';

    let action: 'allow' | 'block' | 'warn' = 'allow';
    let reason = '';

    // Check clipboard monitoring policy
    if (policy?.clipboard?.monitor_paste === false) {
      // Monitoring disabled, allow everything
      return { action: 'allow' };
    }

    // Scan for sensitive data
    const matches = this.scanText(text);
    if (matches.length > 0) {
      const types = [...new Set(matches.map((m) => m.dataType))];
      action = 'warn';
      reason = `Sensitive data detected: ${types.join(', ')}`;

      // If SSN or credit card found, escalate to block
      if (types.includes('ssn') || types.includes('credit_card')) {
        action = 'block';
        reason = `Blocked: sensitive data detected (${types.join(', ')})`;
      }
    }

    this.publishDlpEvent('clipboard_paste', message.tabUrl, tabId, action, {
      matchedPattern: matches.length > 0 ? matches[0].pattern : undefined,
    });

    return {
      action,
      message: reason || undefined,
    };
  }

  private async handleSensitiveData(
    message: ContentMessage,
    tabId: number,
  ): Promise<ContentResponse> {
    const data = message.data as { dataType?: string; fieldName?: string };
    const dataType = data.dataType ?? 'unknown';

    this.publishDlpEvent('sensitive_data', message.tabUrl, tabId, 'warn', {
      dataType: data.dataType,
      matchedPattern: data.fieldName,
    });

    return {
      action: 'warn',
      message: `Sensitive data detected (${dataType.toUpperCase()}) in field "${data.fieldName ?? 'unknown'}". Avoid submitting this data unless required.`,
    };
  }

  private publishDlpEvent(
    type: DlpPayload['type'],
    url: string,
    tabId: number,
    action: 'allow' | 'block' | 'warn',
    extra: { fileName?: string; fileSize?: number; dataType?: string; matchedPattern?: string },
  ): void {
    if (!this.bus) return;
    this.eventCount++;

    const dlpAction: DlpPayload['action'] =
      action === 'block' ? 'blocked' : action === 'warn' ? 'warned' : 'logged';

    const payload: DlpPayload = {
      type,
      url,
      tabId,
      action: dlpAction,
      fileName: extra.fileName,
      fileSize: extra.fileSize,
      dataType: (extra.dataType as DlpPayload['dataType']) ?? undefined,
      matchedPattern: extra.matchedPattern,
    };

    const eventType =
      type === 'file_upload'
        ? EventTypes.DLP_FILE_UPLOAD
        : type === 'clipboard_paste'
          ? EventTypes.DLP_CLIPBOARD
          : EventTypes.DLP_SENSITIVE_DATA;

    const severity = action === 'block' ? 'high' : action === 'warn' ? 'medium' : 'info';

    this.bus.publish(EventBus.createEvent(eventType, this.id, payload, severity));
  }

  /** Read the current DLP policy from chrome.storage (written by PolicyEngine). */
  private async getPolicy(): Promise<DlpPolicy | null> {
    try {
      const result = await chrome.storage.local.get('phoenix_policy');
      const config = result['phoenix_policy'] as { dlp?: DlpPolicy } | undefined;
      return config?.dlp ?? null;
    } catch {
      return null;
    }
  }
}
