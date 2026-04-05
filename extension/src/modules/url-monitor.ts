import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { EventTypes, NavigationPayload } from '../types/events';
import { URL_LRU_CACHE_SIZE } from '../core/constants';

/**
 * Simple LRU cache for deduplicating navigation events (e.g., SPA history changes).
 */
class LRUCache {
  private capacity: number;
  private cache = new Map<string, number>(); // key -> timestamp

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Returns true if the key was already present (duplicate). */
  has(key: string): boolean {
    if (!this.cache.has(key)) return false;
    // Move to end (most recently used)
    const val = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, val);
    return true;
  }

  set(key: string, timestamp: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict oldest (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, timestamp);
  }

  clear(): void {
    this.cache.clear();
  }
}

const FILTERED_SCHEMES = ['chrome:', 'chrome-extension:', 'moz-extension:', 'about:', 'edge:'];

export class UrlMonitor implements PhoenixModule {
  readonly id = 'url-monitor';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private lruCache = new LRUCache(URL_LRU_CACHE_SIZE);
  private lastReferrer = new Map<number, string>(); // tabId -> last URL
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];

  private onCompletedListener:
    | ((details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => void)
    | null = null;
  private onBeforeNavigateListener:
    | ((details: chrome.webNavigation.WebNavigationParentedCallbackDetails) => void)
    | null = null;

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    this.onBeforeNavigateListener = (details) => {
      // Track the current URL as referrer for subsequent navigations in the same tab
      if (details.frameId === 0 && details.url) {
        // We record the URL the tab is navigating FROM (set before navigation completes)
        // The referrer for this new navigation is whatever was there before
      }
    };

    this.onCompletedListener = (details) => {
      try {
        this.handleNavigation(details);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Navigation handler error: ${msg}`);
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(this.onBeforeNavigateListener);
    chrome.webNavigation.onCompleted.addListener(this.onCompletedListener);
  }

  destroy(): void {
    this.enabled = false;
    if (this.onCompletedListener) {
      chrome.webNavigation.onCompleted.removeListener(this.onCompletedListener);
      this.onCompletedListener = null;
    }
    if (this.onBeforeNavigateListener) {
      chrome.webNavigation.onBeforeNavigate.removeListener(this.onBeforeNavigateListener);
      this.onBeforeNavigateListener = null;
    }
    this.lruCache.clear();
    this.lastReferrer.clear();
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

  private handleNavigation(
    details: chrome.webNavigation.WebNavigationFramedCallbackDetails
  ): void {
    if (!this.bus) return;

    // Only track main frame navigations
    if (details.frameId !== 0) return;

    const url = details.url;

    // Filter out internal browser URLs
    if (this.isFilteredUrl(url)) return;

    // Deduplicate using LRU cache (keyed by tabId + url)
    const dedupeKey = `${details.tabId}:${url}`;
    if (this.lruCache.has(dedupeKey)) return;
    this.lruCache.set(dedupeKey, Date.now());

    // Get referrer from previous navigation in this tab
    const referrer = this.lastReferrer.get(details.tabId) ?? null;

    // Determine transition type from the WebNavigation details
    const transitionType = (details as unknown as Record<string, string>).transitionType || 'link';

    const payload: NavigationPayload = {
      url,
      tabId: details.tabId,
      transitionType,
      referrer,
      frameId: details.frameId,
    };

    this.bus.publish(
      EventBus.createEvent(EventTypes.NAVIGATION_VISITED, this.id, payload, 'info')
    );

    this.eventCount++;
    this.lastActivity = Date.now();

    // Update referrer tracking for this tab
    this.lastReferrer.set(details.tabId, url);
  }

  private isFilteredUrl(url: string): boolean {
    for (const scheme of FILTERED_SCHEMES) {
      if (url.startsWith(scheme)) return true;
    }
    return false;
  }
}
