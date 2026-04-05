export interface ThreatDetectionPolicy {
  enabled: boolean;
  blocked_urls: string[];
  blocked_domains: string[];
  blocked_patterns: string[];
  action: string;
}

export interface FileUploadPolicy {
  blocked_extensions: string[];
  max_file_size_mb: number;
  blocked_domains: string[];
}

export interface ClipboardPolicy {
  monitor_paste: boolean;
  monitor_copy: boolean;
}

export interface CustomPattern {
  name: string;
  pattern: string;
  action: string;
}

export interface SensitivePatternsPolicy {
  ssn: boolean;
  credit_card: boolean;
  email: boolean;
  custom_patterns: CustomPattern[];
}

export interface DlpPolicy {
  enabled: boolean;
  file_upload: FileUploadPolicy;
  clipboard: ClipboardPolicy;
  sensitive_patterns: SensitivePatternsPolicy;
}

export interface ExtensionMonitorPolicy {
  enabled: boolean;
  blocked_extensions: string[];
  max_permissions_risk_score: number;
  auto_disable_risky: boolean;
}

export interface IdentityProtectionPolicy {
  enabled: boolean;
  monitored_domains: string[];
  alert_on_session_cookie_removal: boolean;
}

export interface ForensicLoggerPolicy {
  enabled: boolean;
  retention_days: number;
  max_storage_mb: number;
}

export interface CopyPasteRestriction {
  source_domain: string;
  target_domain: string;
  action: string;
  message: string;
}

export interface DownloadRestrictions {
  blocked_extensions: string[];
  require_scan: boolean;
}

export interface GovernancePolicy {
  copy_paste_restrictions: CopyPasteRestriction[];
  download_restrictions: DownloadRestrictions;
}

export interface EdrReporterPolicy {
  endpoint: string;
  batch_interval_seconds: number;
  max_batch_size: number;
  retry_attempts: number;
  retry_backoff_ms: number;
}

export interface PolicyConfig {
  version: string;
  updated_at: string;
  threat_detection: ThreatDetectionPolicy;
  dlp: DlpPolicy;
  extension_monitor: ExtensionMonitorPolicy;
  identity_protection: IdentityProtectionPolicy;
  forensic_logger: ForensicLoggerPolicy;
  governance: GovernancePolicy;
  edr_reporter: EdrReporterPolicy;
}
