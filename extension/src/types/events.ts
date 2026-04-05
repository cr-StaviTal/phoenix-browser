// Event severity levels
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

// Base event interface - all events must conform to this
export interface PhoenixEvent<T = unknown> {
  type: string;
  timestamp: number;
  source: string;       // Module ID that emitted it
  payload: T;
  severity: Severity;
}

// Event type constants
export const EventTypes = {
  // URL Monitor
  NAVIGATION_VISITED: 'navigation.visited',
  NAVIGATION_REDIRECT: 'navigation.redirect',

  // Threat Detection
  THREAT_DETECTED: 'threat.detected',
  THREAT_BLOCKED: 'threat.blocked',

  // Extension Monitor
  EXT_INSTALLED: 'extension.installed',
  EXT_UNINSTALLED: 'extension.uninstalled',
  EXT_ENABLED: 'extension.enabled',
  EXT_DISABLED: 'extension.disabled',
  EXT_PERMISSIONS_CHANGED: 'extension.permissions_changed',

  // DLP
  DLP_FILE_UPLOAD: 'dlp.file_upload',
  DLP_CLIPBOARD: 'dlp.clipboard',
  DLP_SENSITIVE_DATA: 'dlp.sensitive_data',

  // Identity Protection
  IDENTITY_COOKIE_CHANGE: 'identity.cookie_change',
  IDENTITY_SESSION_ANOMALY: 'identity.session_anomaly',

  // Policy
  POLICY_LOADED: 'policy.loaded',
  POLICY_VIOLATED: 'policy.violated',
  POLICY_UPDATE_FAILED: 'policy.update_failed',

  // Rule Engine
  RULE_MATCHED: 'rule.matched',
  RULE_ACTION_EXECUTED: 'rule.action_executed',
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// Payload types
export interface NavigationPayload {
  url: string;
  tabId: number;
  transitionType: string;
  referrer: string | null;
  frameId: number;
}

export interface ThreatPayload {
  url: string;
  threatType: 'phishing' | 'malware' | 'blocklisted';
  listSource: string;
  action: 'blocked' | 'warned';
  tabId: number;
  matchedRule: string;
}

export interface ExtensionPayload {
  extensionId: string;
  name: string;
  action: 'installed' | 'uninstalled' | 'enabled' | 'disabled' | 'permissions_changed';
  permissions: string[];
  riskScore: number;
}

export interface DlpPayload {
  type: 'file_upload' | 'clipboard_paste' | 'sensitive_data';
  url: string;
  tabId: number;
  dataType?: 'ssn' | 'credit_card' | 'email' | 'custom';
  fileName?: string;
  fileSize?: number;
  action: 'blocked' | 'warned' | 'logged';
  matchedPattern?: string;
}

export interface IdentityPayload {
  type: 'cookie_change' | 'session_anomaly';
  domain: string;
  cookieName?: string;
  changeType?: 'added' | 'removed' | 'modified';
  isSessionCookie: boolean;
  isSecure: boolean;
  isHttpOnly: boolean;
}

export interface PolicyPayload {
  action: 'policy_loaded' | 'policy_violated' | 'policy_update_failed';
  policyVersion: string;
  violatedRule?: string;
  details?: string;
}

export interface RuleMatchedPayload {
  ruleId: string;
  ruleName: string;
  url: string;
  tabId: number;
  trigger: string;
  actionsExecuted: string[];
  severity: string;
}
