export const EXTENSION_ID = 'phoenix-shield';
export const EXTENSION_VERSION = '1.0.0';

// Default EDR agent endpoint
export const DEFAULT_EDR_ENDPOINT = 'http://localhost:8745/api';

// Event batching
export const BATCH_INTERVAL_MS = 30_000;     // 30 seconds
export const MAX_BATCH_SIZE = 500;

// Storage limits
export const MAX_FORENSIC_STORAGE_MB = 80;
export const MAX_RETRY_QUEUE_MB = 5;

// Policy
export const POLICY_REFRESH_INTERVAL_MS = 300_000;  // 5 minutes
export const POLICY_STORAGE_KEY = 'phoenix_policy';

// Forensic logging
export const LOG_RETENTION_DAYS = 7;
export const LOG_ROTATION_INTERVAL_MS = 3_600_000;  // 1 hour

// URL Monitor
export const URL_LRU_CACHE_SIZE = 1000;

// Extension Monitor
export const EXTENSION_SCAN_INTERVAL_MS = 21_600_000;  // 6 hours

// Rules
export const RULES_STORAGE_KEY = 'phoenix_rules';
export const RULES_REFRESH_INTERVAL_MS = 30_000; // 30 seconds - fast rule propagation

// Alarms (chrome.alarms API names)
export const ALARM_NAMES = {
  EDR_REPORT_FLUSH: 'edr-report-flush',
  POLICY_REFRESH: 'policy-refresh',
  LOG_ROTATION: 'log-rotation',
  EXTENSION_SCAN: 'extension-scan',
  RULES_REFRESH: 'rules-refresh',
} as const;
