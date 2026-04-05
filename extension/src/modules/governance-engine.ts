import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { EventTypes, PolicyPayload } from '../types/events';
import { GovernancePolicy, CopyPasteRestriction } from '../types/policy';
import { PolicyEngine } from './policy-engine';

interface GovernanceMessage {
  type: 'governance:paste-check' | 'governance:copy-check';
  tabUrl: string;
  data: {
    sourceDomain?: string;
    targetDomain?: string;
    text?: string;
  };
}

interface GovernanceResponse {
  action: 'allow' | 'block' | 'warn';
  message?: string;
}

export class GovernanceEngine implements PhoenixModule {
  readonly id = 'governance-engine';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private policyEngine: PolicyEngine | null = null;
  private governancePolicy: GovernancePolicy = {
    copy_paste_restrictions: [],
    download_restrictions: {
      blocked_extensions: [],
      require_scan: false,
    },
  };
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private violationCount = 0;

  private messageListener:
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: GovernanceResponse) => void,
      ) => boolean | undefined)
    | null = null;

  private downloadListener: ((item: chrome.downloads.DownloadItem) => void) | null = null;
  private policyUnsubscribe: (() => void) | null = null;

  setPolicyEngine(policyEngine: PolicyEngine): void {
    this.policyEngine = policyEngine;
  }

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // Load governance policy from PolicyEngine if already available
    if (this.policyEngine) {
      this.governancePolicy = this.policyEngine.getPolicy().governance;
    }

    // Subscribe to POLICY_LOADED to keep governance rules in sync
    this.policyUnsubscribe = bus.subscribe<PolicyPayload>(
      EventTypes.POLICY_LOADED,
      () => {
        if (this.policyEngine) {
          this.governancePolicy = this.policyEngine.getPolicy().governance;
        }
      },
    );

    // Set up message listener for copy/paste checks from content scripts
    this.messageListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: GovernanceResponse) => void,
    ): boolean | undefined => {
      const msg = message as GovernanceMessage;

      if (
        msg?.type !== 'governance:paste-check' &&
        msg?.type !== 'governance:copy-check'
      ) {
        return undefined;
      }

      this.handleCopyPasteCheck(msg)
        .then((response) => sendResponse(response))
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.errors.push(`Copy/paste check error: ${errMsg}`);
          sendResponse({ action: 'allow' });
        });

      return true; // keep channel open for async
    };

    chrome.runtime.onMessage.addListener(this.messageListener);

    // Set up download listener
    this.downloadListener = (item: chrome.downloads.DownloadItem) => {
      this.handleDownloadCreated(item).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Download check error: ${errMsg}`);
      });
    };

    chrome.downloads.onCreated.addListener(this.downloadListener);
  }

  destroy(): void {
    this.enabled = false;

    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }

    if (this.downloadListener) {
      chrome.downloads.onCreated.removeListener(this.downloadListener);
      this.downloadListener = null;
    }

    if (this.policyUnsubscribe) {
      this.policyUnsubscribe();
      this.policyUnsubscribe = null;
    }

    this.bus = null;
  }

  getStatus(): ModuleStatus {
    return {
      id: this.id,
      enabled: this.enabled,
      lastActivity: this.lastActivity,
      eventCount: this.eventCount,
      errors: [...this.errors.slice(-10), `violations: ${this.violationCount}`],
    };
  }

  // ---- Copy/paste enforcement ----

  private async handleCopyPasteCheck(msg: GovernanceMessage): Promise<GovernanceResponse> {
    const restrictions = this.governancePolicy.copy_paste_restrictions;
    if (!restrictions || restrictions.length === 0) {
      return { action: 'allow' };
    }

    const isPaste = msg.type === 'governance:paste-check';
    const domain = isPaste ? msg.data.targetDomain : msg.data.sourceDomain;
    if (!domain) {
      return { action: 'allow' };
    }

    const matched = this.findMatchingRestriction(restrictions, domain, isPaste);
    if (!matched) {
      return { action: 'allow' };
    }

    this.lastActivity = Date.now();
    this.eventCount++;

    const action = matched.action as 'allow' | 'block' | 'warn';

    if (action === 'block' || action === 'warn') {
      this.violationCount++;
      this.publishPolicyViolated(
        isPaste ? 'copy_paste:paste_blocked' : 'copy_paste:copy_blocked',
        `${isPaste ? 'Paste' : 'Copy'} ${action}ed on domain: ${domain}`,
      );
    }

    return {
      action,
      message: matched.message || (action === 'block'
        ? `${isPaste ? 'Paste' : 'Copy'} blocked by security policy.`
        : `Warning: ${isPaste ? 'paste' : 'copy'} may violate security policy.`),
    };
  }

  private findMatchingRestriction(
    restrictions: CopyPasteRestriction[],
    domain: string,
    isPaste: boolean,
  ): CopyPasteRestriction | null {
    for (const r of restrictions) {
      const domainToMatch = isPaste ? r.target_domain : r.source_domain;
      if (this.domainMatches(domain, domainToMatch)) {
        return r;
      }
    }
    return null;
  }

  private domainMatches(domain: string, pattern: string): boolean {
    if (!pattern || pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return domain === suffix || domain.endsWith(`.${suffix}`);
    }
    return domain === pattern;
  }

  // ---- Download enforcement ----

  private async handleDownloadCreated(item: chrome.downloads.DownloadItem): Promise<void> {
    const blockedExtensions = this.governancePolicy.download_restrictions?.blocked_extensions ?? [];
    if (blockedExtensions.length === 0) return;

    const filename = item.filename || item.url || '';
    const ext = this.extractExtension(filename);
    if (!ext) return;

    const normalizedExt = ext.toLowerCase();
    const isBlocked = blockedExtensions.some(
      (blocked) => blocked.toLowerCase() === normalizedExt,
    );

    if (!isBlocked) return;

    // Cancel the download
    try {
      await new Promise<void>((resolve, reject) => {
        chrome.downloads.cancel(item.id, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Failed to cancel download ${item.id}: ${msg}`);
    }

    this.lastActivity = Date.now();
    this.eventCount++;
    this.violationCount++;

    // Show notification
    chrome.notifications.create(`governance-download-${item.id}`, {
      type: 'basic',
      iconUrl: 'assets/icons/icon-48.png',
      title: 'Phoenix Shield - Download Blocked',
      message: `Download of "${this.basename(filename)}" was blocked because the file type (${normalizedExt}) is not permitted by security policy.`,
      priority: 2,
    });

    this.publishPolicyViolated(
      'download:blocked_extension',
      `Download blocked: ${this.basename(filename)} (${normalizedExt})`,
    );
  }

  private extractExtension(filename: string): string | null {
    try {
      // Strip query string / fragment if it looks like a URL
      const clean = filename.split('?')[0].split('#')[0];
      const base = clean.split('/').pop() ?? clean;
      const dot = base.lastIndexOf('.');
      if (dot === -1 || dot === base.length - 1) return null;
      return base.slice(dot); // includes the dot, e.g. ".exe"
    } catch {
      return null;
    }
  }

  private basename(filename: string): string {
    const clean = filename.split('?')[0].split('#')[0];
    return clean.split('/').pop() ?? clean;
  }

  // ---- Event publishing ----

  private publishPolicyViolated(violatedRule: string, details: string): void {
    if (!this.bus) return;
    const payload: PolicyPayload = {
      action: 'policy_violated',
      policyVersion: this.policyEngine?.getPolicy().version ?? 'unknown',
      violatedRule,
      details,
    };
    this.bus.publish(
      EventBus.createEvent(EventTypes.POLICY_VIOLATED, this.id, payload, 'high'),
    );
  }
}
