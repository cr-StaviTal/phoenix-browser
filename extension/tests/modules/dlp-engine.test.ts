import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DlpEngine } from '../../src/modules/dlp-engine';
import { EventBus } from '../../src/core/event-bus';
import { EventTypes } from '../../src/types/events';

describe('DlpEngine', () => {
  let bus: EventBus;
  let dlp: DlpEngine;

  beforeEach(() => {
    bus = new EventBus();
    dlp = new DlpEngine();
    dlp.register(bus);
  });

  // ------------------------------------------------------------------
  // SSN pattern detection
  // ------------------------------------------------------------------
  describe('SSN pattern detection', () => {
    it('detects a valid SSN with dashes: 123-45-6789', () => {
      const matches = dlp.scanText('My SSN is 123-45-6789 thanks');
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe('SSN');
      expect(matches[0].dataType).toBe('ssn');
      expect(matches[0].match).toBe('123-45-6789');
    });

    it('detects a valid SSN without dashes: 123456789', () => {
      const matches = dlp.scanText('SSN: 123456789');
      expect(matches).toHaveLength(1);
      expect(matches[0].dataType).toBe('ssn');
    });

    it('detects multiple SSNs in one text', () => {
      const matches = dlp.scanText('First: 123-45-6789, Second: 234-56-7890');
      const ssns = matches.filter((m) => m.dataType === 'ssn');
      expect(ssns.length).toBe(2);
    });

    it('rejects SSN with area 000', () => {
      const matches = dlp.scanText('Invalid: 000-45-6789');
      const ssns = matches.filter((m) => m.dataType === 'ssn');
      expect(ssns).toHaveLength(0);
    });

    it('rejects SSN with area 666', () => {
      const matches = dlp.scanText('Invalid: 666-45-6789');
      const ssns = matches.filter((m) => m.dataType === 'ssn');
      expect(ssns).toHaveLength(0);
    });

    it('rejects SSN with area 900+', () => {
      const matches = dlp.scanText('Invalid: 900-45-6789');
      const ssns900 = matches.filter((m) => m.dataType === 'ssn');
      expect(ssns900).toHaveLength(0);

      const matches2 = dlp.scanText('Invalid: 999-45-6789');
      const ssns999 = matches2.filter((m) => m.dataType === 'ssn');
      expect(ssns999).toHaveLength(0);
    });

    it('rejects SSN with group 00', () => {
      const matches = dlp.scanText('Invalid: 123-00-6789');
      const ssns = matches.filter((m) => m.dataType === 'ssn');
      expect(ssns).toHaveLength(0);
    });

    it('rejects SSN with serial 0000', () => {
      const matches = dlp.scanText('Invalid: 123-45-0000');
      const ssns = matches.filter((m) => m.dataType === 'ssn');
      expect(ssns).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // Credit card pattern detection
  // ------------------------------------------------------------------
  describe('credit card pattern detection', () => {
    it('detects a valid Visa number (passes Luhn)', () => {
      // 4111111111111111 is a well-known test Visa number that passes Luhn.
      const matches = dlp.scanText('Card: 4111111111111111');
      const cards = matches.filter((m) => m.dataType === 'credit_card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
      expect(cards[0].pattern).toBe('Credit Card');
    });

    it('detects a valid card with spaces', () => {
      const matches = dlp.scanText('Pay with 4111 1111 1111 1111 please');
      const cards = matches.filter((m) => m.dataType === 'credit_card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });

    it('detects a valid card with dashes', () => {
      const matches = dlp.scanText('Card: 4111-1111-1111-1111');
      const cards = matches.filter((m) => m.dataType === 'credit_card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects a number that fails Luhn check', () => {
      // 4111111111111112 fails Luhn.
      const matches = dlp.scanText('Not a card: 4111111111111112');
      const cards = matches.filter((m) => m.dataType === 'credit_card');
      expect(cards).toHaveLength(0);
    });

    it('detects a valid MasterCard number', () => {
      // 5500000000000004 is a test MasterCard that passes Luhn.
      const matches = dlp.scanText('MC: 5500000000000004');
      const cards = matches.filter((m) => m.dataType === 'credit_card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ------------------------------------------------------------------
  // Email pattern detection
  // ------------------------------------------------------------------
  describe('email pattern detection', () => {
    it('detects a standard email address', () => {
      const matches = dlp.scanText('Contact: user@example.com for details');
      const emails = matches.filter((m) => m.dataType === 'email');
      expect(emails).toHaveLength(1);
      expect(emails[0].match).toBe('user@example.com');
    });

    it('detects emails with dots and plus signs', () => {
      const matches = dlp.scanText('john.doe+tag@company.co.uk');
      const emails = matches.filter((m) => m.dataType === 'email');
      expect(emails).toHaveLength(1);
    });

    it('detects multiple emails in one text', () => {
      const matches = dlp.scanText('From: a@b.com To: c@d.org CC: e@f.net');
      const emails = matches.filter((m) => m.dataType === 'email');
      expect(emails).toHaveLength(3);
    });

    it('does not match strings without @ or TLD', () => {
      const matches = dlp.scanText('not-an-email and also@noTLD');
      const emails = matches.filter((m) => m.dataType === 'email');
      expect(emails).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // File upload blocking
  // ------------------------------------------------------------------
  describe('file upload handling', () => {
    it('blocks uploads with prohibited extensions via message handler', async () => {
      // Set up a policy with blocked extensions
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        phoenix_policy: {
          dlp: {
            enabled: true,
            file_upload: {
              blocked_extensions: ['.exe', '.bat', '.ps1'],
              max_file_size_mb: 25,
              blocked_domains: [],
            },
            clipboard: { monitor_paste: true, monitor_copy: true },
            sensitive_patterns: { ssn: true, credit_card: true, email: true, custom_patterns: [] },
          },
        },
      });

      // Simulate a content script message through chrome.runtime.onMessage
      const sendResponse = vi.fn();
      const listener = (chrome.runtime.onMessage as any).addListener.mock.calls[0][0];

      // Call the listener directly
      const keepOpen = listener(
        {
          type: 'dlp:file-input-detected' as const,
          tabUrl: 'https://upload-site.com',
          data: { fileName: 'malware.exe', fileSize: 1024 },
        },
        { tab: { id: 10 } },
        sendResponse,
      );

      expect(keepOpen).toBe(true); // async response

      // Wait for the async handler to resolve
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'block' }),
      );
    });

    it('allows uploads with safe extensions', async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        phoenix_policy: {
          dlp: {
            enabled: true,
            file_upload: {
              blocked_extensions: ['.exe', '.bat'],
              max_file_size_mb: 25,
              blocked_domains: [],
            },
            clipboard: { monitor_paste: true, monitor_copy: true },
            sensitive_patterns: { ssn: true, credit_card: true, email: true, custom_patterns: [] },
          },
        },
      });

      const sendResponse = vi.fn();
      const listener = (chrome.runtime.onMessage as any).addListener.mock.calls[0][0];

      listener(
        {
          type: 'dlp:file-input-detected' as const,
          tabUrl: 'https://upload-site.com',
          data: { fileName: 'document.pdf', fileSize: 1024 },
        },
        { tab: { id: 10 } },
        sendResponse,
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'allow' }),
      );
    });

    it('publishes DLP_FILE_UPLOAD event on file upload', async () => {
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
        async () => ({ phoenix_policy: { dlp: null } }),
      );

      const handler = vi.fn();
      bus.subscribe(EventTypes.DLP_FILE_UPLOAD, handler);

      const sendResponse = vi.fn();
      const listener = (chrome.runtime.onMessage as any).addListener.mock.calls[0][0];

      listener(
        {
          type: 'dlp:file-input-detected' as const,
          tabUrl: 'https://example.com',
          data: { fileName: 'file.txt', fileSize: 100 },
        },
        { tab: { id: 5 } },
        sendResponse,
      );

      // Wait for the async promise chain (getPolicy await + then) to settle.
      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      }, { timeout: 500 });

      expect(handler.mock.calls[0][0].payload.type).toBe('file_upload');
    });
  });

  // ------------------------------------------------------------------
  // scanText - comprehensive
  // ------------------------------------------------------------------
  describe('scanText returns all matches', () => {
    it('detects mixed sensitive data in one text block', () => {
      const text =
        'SSN: 123-45-6789, Card: 4111111111111111, Email: test@example.com';
      const matches = dlp.scanText(text);

      const types = matches.map((m) => m.dataType);
      expect(types).toContain('ssn');
      expect(types).toContain('credit_card');
      expect(types).toContain('email');
    });

    it('returns empty array for clean text', () => {
      const matches = dlp.scanText('This is perfectly safe text with no sensitive data.');
      // Filter out any spurious number matches
      const sensitive = matches.filter((m) => ['ssn', 'credit_card'].includes(m.dataType));
      expect(sensitive).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // Module lifecycle
  // ------------------------------------------------------------------
  describe('module lifecycle', () => {
    it('reports correct status', () => {
      const status = dlp.getStatus();
      expect(status.id).toBe('dlp-engine');
      expect(status.enabled).toBe(true);
      expect(status.eventCount).toBe(0);
    });

    it('removes message listener on destroy', () => {
      dlp.destroy();

      expect(dlp.getStatus().enabled).toBe(false);
      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
    });

    it('ignores non-dlp messages', async () => {
      const sendResponse = vi.fn();
      const listener = (chrome.runtime.onMessage as any).addListener.mock.calls[0][0];

      const result = listener(
        { type: 'some-other-message', tabUrl: 'https://x.com', data: {} },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Should return false (not ours) and not call sendResponse
      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });
});
