import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreatDetection } from '../../src/modules/threat-detection';
import { EventBus } from '../../src/core/event-bus';
import { EventTypes, NavigationPayload } from '../../src/types/events';

describe('ThreatDetection', () => {
  let bus: EventBus;
  let td: ThreatDetection;

  beforeEach(() => {
    bus = new EventBus();
    td = new ThreatDetection();
    td.register(bus);
  });

  // ------------------------------------------------------------------
  // registration
  // ------------------------------------------------------------------
  describe('registration', () => {
    it('subscribes to NAVIGATION_VISITED on register', () => {
      // The module subscribed during beforeEach; verify by publishing a navigation
      // event for a blocklisted domain and checking that threat events are emitted.
      const handler = vi.fn();
      bus.subscribe(EventTypes.THREAT_DETECTED, handler);

      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://evil-phishing.example.com/login',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(handler).toHaveBeenCalledOnce();
    });

    it('is enabled after registration', () => {
      const status = td.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.id).toBe('threat-detection');
    });

    it('can be destroyed and stops processing events', () => {
      td.destroy();

      const handler = vi.fn();
      bus.subscribe(EventTypes.THREAT_DETECTED, handler);

      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://evil-phishing.example.com/path',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // threat event publishing
  // ------------------------------------------------------------------
  describe('threat event publishing', () => {
    it('publishes THREAT_DETECTED and THREAT_BLOCKED for blocklisted URLs', () => {
      const detected = vi.fn();
      const blocked = vi.fn();
      bus.subscribe(EventTypes.THREAT_DETECTED, detected);
      bus.subscribe(EventTypes.THREAT_BLOCKED, blocked);

      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://evil-phishing.example.com/steal',
            tabId: 42,
            transitionType: 'link',
            referrer: 'https://legit.com',
            frameId: 0,
          },
          'info',
        ),
      );

      expect(detected).toHaveBeenCalledOnce();
      expect(blocked).toHaveBeenCalledOnce();

      const payload = detected.mock.calls[0][0].payload;
      expect(payload.url).toBe('https://evil-phishing.example.com/steal');
      expect(payload.threatType).toBe('blocklisted');
      expect(payload.action).toBe('blocked');
      expect(payload.tabId).toBe(42);
    });

    it('publishes with high severity', () => {
      const detected = vi.fn();
      bus.subscribe(EventTypes.THREAT_DETECTED, detected);

      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://malware-download.example.net/virus.exe',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(detected.mock.calls[0][0].severity).toBe('high');
    });
  });

  // ------------------------------------------------------------------
  // domain matching
  // ------------------------------------------------------------------
  describe('domain matching', () => {
    it.each([
      'https://evil-phishing.example.com',
      'https://evil-phishing.example.com/path/to/page',
      'https://evil-phishing.example.com:8080/login',
    ])('matches default blocked domain: %s', (url) => {
      const match = td.check(url);
      expect(match).not.toBeNull();
      expect(match!.matchType).toBe('domain');
      expect(match!.matchedRule).toBe('evil-phishing.example.com');
    });

    it.each([
      'https://malware-download.example.net/payload',
      'https://fake-login.example.org/page',
    ])('matches other default blocked domains: %s', (url) => {
      const match = td.check(url);
      expect(match).not.toBeNull();
      expect(match!.matchType).toBe('domain');
    });

    it('does not match safe domains', () => {
      expect(td.check('https://google.com')).toBeNull();
      expect(td.check('https://safe-site.example.com')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // pattern (glob) matching
  // ------------------------------------------------------------------
  describe('pattern matching', () => {
    it('matches glob patterns from blocklist', () => {
      // We need to add a pattern to the blocklist. The simplest way is to
      // simulate a policy reload via chrome.storage.
      // Instead, test the check() method after manually setting up via
      // a fresh instance that has been configured via policy.

      // For unit testing, use the check() method directly after populating
      // the blocklist through a policy.loaded event.
      const freshBus = new EventBus();
      const freshTd = new ThreatDetection();
      freshTd.register(freshBus);

      // Simulate policy load by writing to chrome.storage and firing event
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        phoenix_policy: {
          threat_detection: {
            blocked_urls: [],
            blocked_domains: [],
            blocked_patterns: ['*malicious-cdn*', 'https://phish.*.com/*'],
          },
        },
      });

      // Trigger policy loaded event
      freshBus.publish(
        EventBus.createEvent(EventTypes.POLICY_LOADED, 'policy-engine', {
          action: 'policy_loaded',
          policyVersion: '1.0.0',
        }),
      );

      // Give the async onPolicyLoaded a tick to complete
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const match1 = freshTd.check('https://malicious-cdn.example.com/script.js');
          expect(match1).not.toBeNull();
          expect(match1!.matchType).toBe('pattern');
          expect(match1!.matchedRule).toBe('*malicious-cdn*');

          const match2 = freshTd.check('https://phish.evil.com/login');
          expect(match2).not.toBeNull();
          expect(match2!.matchType).toBe('pattern');

          resolve();
        }, 50);
      });
    });
  });

  // ------------------------------------------------------------------
  // non-matching URLs
  // ------------------------------------------------------------------
  describe('non-matching URLs', () => {
    it('does not publish threat events for safe URLs', () => {
      const handler = vi.fn();
      bus.subscribe(EventTypes.THREAT_DETECTED, handler);

      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://www.google.com/search?q=hello',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('returns null from check() for safe URLs', () => {
      expect(td.check('https://www.example.com')).toBeNull();
      expect(td.check('https://github.com/repo')).toBeNull();
      expect(td.check('https://docs.microsoft.com/en-us')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // status reporting
  // ------------------------------------------------------------------
  describe('status reporting', () => {
    it('reports correct initial status', () => {
      const status = td.getStatus();
      expect(status.id).toBe('threat-detection');
      expect(status.enabled).toBe(true);
      expect(status.eventCount).toBe(0);
      expect(status.lastActivity).toBe(0);
    });

    it('increments eventCount after detecting a threat', () => {
      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://evil-phishing.example.com/page',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(td.getStatus().eventCount).toBe(1);
    });

    it('updates lastActivity after detecting a threat', () => {
      const before = Date.now();

      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://fake-login.example.org/login',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      const after = Date.now();
      const last = td.getStatus().lastActivity;
      expect(last).toBeGreaterThanOrEqual(before);
      expect(last).toBeLessThanOrEqual(after);
    });

    it('reports disabled after destroy', () => {
      td.destroy();
      expect(td.getStatus().enabled).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // chrome API interactions
  // ------------------------------------------------------------------
  describe('chrome API interactions', () => {
    it('calls declarativeNetRequest.updateDynamicRules on threat', () => {
      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://evil-phishing.example.com/page',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalled();
    });

    it('shows a notification on threat', () => {
      bus.publish(
        EventBus.createEvent<NavigationPayload>(
          EventTypes.NAVIGATION_VISITED,
          'url-monitor',
          {
            url: 'https://evil-phishing.example.com/page',
            tabId: 1,
            transitionType: 'typed',
            referrer: null,
            frameId: 0,
          },
          'info',
        ),
      );

      expect(chrome.notifications.create).toHaveBeenCalled();
    });
  });
});
