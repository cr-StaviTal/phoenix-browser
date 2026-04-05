import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import {
  EventTypes,
  IdentityPayload,
  NavigationPayload,
  PolicyPayload,
} from '../types/events';
import { IdentityProtectionPolicy } from '../types/policy';

const LOGOUT_PATTERNS = ['/logout', '/signout', '/sign-out'];

export class IdentityProtection implements PhoenixModule {
  readonly id = 'identity-protection';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private unsubscribes: Array<() => void> = [];

  /** domain -> set of tracked cookie names */
  private sessions: Map<string, Set<string>> = new Map();
  /** Domains we are actively monitoring (from policy). Empty = monitor all. */
  private monitoredDomains: Set<string> = new Set();
  /** Domains where a logout was recently detected, so cookie removal is expected. */
  private recentLogouts: Set<string> = new Set();

  private cookieListener:
    | ((changeInfo: chrome.cookies.CookieChangeInfo) => void)
    | null = null;

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // Watch cookie changes
    this.cookieListener = (changeInfo) => {
      try {
        this.onCookieChanged(changeInfo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Cookie handler error: ${msg}`);
      }
    };
    chrome.cookies.onChanged.addListener(this.cookieListener);

    // Track navigations to detect logouts
    const unsubNav = bus.subscribe<NavigationPayload>(
      EventTypes.NAVIGATION_VISITED,
      (event) => this.onNavigation(event.payload),
    );
    this.unsubscribes.push(unsubNav);

    // Update monitored domains from policy
    const unsubPolicy = bus.subscribe<PolicyPayload>(
      EventTypes.POLICY_LOADED,
      () => this.onPolicyLoaded(),
    );
    this.unsubscribes.push(unsubPolicy);

    // Load initial policy
    this.onPolicyLoaded();
  }

  destroy(): void {
    this.enabled = false;
    if (this.cookieListener) {
      chrome.cookies.onChanged.removeListener(this.cookieListener);
      this.cookieListener = null;
    }
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    this.sessions.clear();
    this.recentLogouts.clear();
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

  // ---- Private ----

  private onCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): void {
    const { cookie, removed, cause } = changeInfo;
    const domain = cookie.domain.replace(/^\./, ''); // strip leading dot

    // Only monitor configured domains (if list is non-empty)
    if (this.monitoredDomains.size > 0 && !this.monitoredDomains.has(domain)) {
      return;
    }

    this.lastActivity = Date.now();

    const isSessionCookie = !cookie.expirationDate; // no expiry = session cookie
    const cookieName = cookie.name;

    if (removed) {
      this.onCookieRemoved(domain, cookieName, isSessionCookie, cause);
    } else {
      this.onCookieSet(domain, cookie, isSessionCookie);
    }
  }

  private onCookieRemoved(
    domain: string,
    cookieName: string,
    isSessionCookie: boolean,
    cause: string,
  ): void {
    const trackedNames = this.sessions.get(domain);

    // Session cookie removed unexpectedly (not during a logout flow)
    if (
      isSessionCookie &&
      trackedNames?.has(cookieName) &&
      !this.recentLogouts.has(domain)
    ) {
      this.publishAnomaly(domain, cookieName, isSessionCookie, 'removed', 'high');
    } else {
      this.publishCookieChange(domain, cookieName, isSessionCookie, 'removed');
    }

    // Remove from tracking
    trackedNames?.delete(cookieName);
    if (trackedNames?.size === 0) {
      this.sessions.delete(domain);
    }
  }

  private onCookieSet(
    domain: string,
    cookie: chrome.cookies.Cookie,
    isSessionCookie: boolean,
  ): void {
    const cookieName = cookie.name;
    const existing = this.sessions.get(domain);

    if (existing?.has(cookieName)) {
      // Cookie is being replaced -- check for security downgrades
      if (!cookie.secure) {
        // We cannot know the previous cookie's flags from chrome.cookies.onChanged
        // alone. The changeInfo only gives us the new state. We track names and
        // detect replacement of a tracked cookie with a non-secure one as suspicious.
        this.publishAnomaly(domain, cookieName, isSessionCookie, 'modified', 'high');
      } else if (!cookie.httpOnly) {
        this.publishAnomaly(domain, cookieName, isSessionCookie, 'modified', 'medium');
      } else {
        this.publishCookieChange(domain, cookieName, isSessionCookie, 'modified');
      }
    } else {
      // New cookie
      this.publishCookieChange(domain, cookieName, isSessionCookie, 'added');
    }

    // Track the cookie
    if (!this.sessions.has(domain)) {
      this.sessions.set(domain, new Set());
    }
    this.sessions.get(domain)!.add(cookieName);
  }

  private onNavigation(nav: NavigationPayload): void {
    const urlLower = nav.url.toLowerCase();
    const isLogout = LOGOUT_PATTERNS.some((p) => urlLower.includes(p));
    if (!isLogout) return;

    let domain: string;
    try {
      domain = new URL(nav.url).hostname;
    } catch {
      return;
    }

    // Mark logout so cookie removals for this domain are expected
    this.recentLogouts.add(domain);

    // Clear session tracking for the domain
    this.sessions.delete(domain);

    // Clear the logout marker after a short window (10 seconds)
    setTimeout(() => {
      this.recentLogouts.delete(domain);
    }, 10_000);
  }

  private async onPolicyLoaded(): Promise<void> {
    try {
      const result = await chrome.storage.local.get('phoenix_policy');
      const config = result['phoenix_policy'] as
        | { identity_protection?: IdentityProtectionPolicy }
        | undefined;

      if (config?.identity_protection?.monitored_domains) {
        this.monitoredDomains = new Set(config.identity_protection.monitored_domains);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Policy reload failed: ${msg}`);
    }
  }

  private publishAnomaly(
    domain: string,
    cookieName: string,
    isSessionCookie: boolean,
    changeType: 'added' | 'removed' | 'modified',
    severity: 'medium' | 'high',
  ): void {
    if (!this.bus) return;
    this.eventCount++;

    const payload: IdentityPayload = {
      type: 'session_anomaly',
      domain,
      cookieName,
      changeType,
      isSessionCookie,
      isSecure: false,
      isHttpOnly: false,
    };

    this.bus.publish(
      EventBus.createEvent(EventTypes.IDENTITY_SESSION_ANOMALY, this.id, payload, severity),
    );
  }

  private publishCookieChange(
    domain: string,
    cookieName: string,
    isSessionCookie: boolean,
    changeType: 'added' | 'removed' | 'modified',
  ): void {
    if (!this.bus) return;
    this.eventCount++;

    const payload: IdentityPayload = {
      type: 'cookie_change',
      domain,
      cookieName,
      changeType,
      isSessionCookie,
      isSecure: true,
      isHttpOnly: true,
    };

    this.bus.publish(
      EventBus.createEvent(EventTypes.IDENTITY_COOKIE_CHANGE, this.id, payload, 'info'),
    );
  }
}
