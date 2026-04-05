"""Policy configuration models."""
from pydantic import BaseModel, Field


class ThreatDetectionPolicy(BaseModel):
    enabled: bool = True
    blocked_urls: list[str] = Field(default_factory=list)
    blocked_domains: list[str] = Field(default_factory=list)
    blocked_patterns: list[str] = Field(default_factory=list)
    action: str = "block"


class FileUploadPolicy(BaseModel):
    blocked_extensions: list[str] = Field(default_factory=lambda: [".exe", ".bat", ".ps1", ".cmd", ".scr"])
    max_file_size_mb: int = 25
    blocked_domains: list[str] = Field(default_factory=list)


class ClipboardPolicy(BaseModel):
    monitor_paste: bool = True
    monitor_copy: bool = True


class CustomPattern(BaseModel):
    name: str
    pattern: str
    action: str = "warn"


class SensitivePatternsPolicy(BaseModel):
    ssn: bool = True
    credit_card: bool = True
    email: bool = True
    custom_patterns: list[CustomPattern] = Field(default_factory=list)


class DlpPolicy(BaseModel):
    enabled: bool = True
    file_upload: FileUploadPolicy = Field(default_factory=FileUploadPolicy)
    clipboard: ClipboardPolicy = Field(default_factory=ClipboardPolicy)
    sensitive_patterns: SensitivePatternsPolicy = Field(default_factory=SensitivePatternsPolicy)


class ExtensionMonitorPolicy(BaseModel):
    enabled: bool = True
    blocked_extensions: list[str] = Field(default_factory=list)
    max_permissions_risk_score: int = 70
    auto_disable_risky: bool = False


class IdentityProtectionPolicy(BaseModel):
    enabled: bool = True
    monitored_domains: list[str] = Field(default_factory=list)
    alert_on_session_cookie_removal: bool = True


class ForensicLoggerPolicy(BaseModel):
    enabled: bool = True
    retention_days: int = 7
    max_storage_mb: int = 80


class CopyPasteRestriction(BaseModel):
    source_domain: str
    target_domain: str = "*"
    action: str = "block"
    message: str = ""


class DownloadRestrictions(BaseModel):
    blocked_extensions: list[str] = Field(default_factory=lambda: [".torrent"])
    require_scan: bool = False


class GovernancePolicy(BaseModel):
    copy_paste_restrictions: list[CopyPasteRestriction] = Field(default_factory=list)
    download_restrictions: DownloadRestrictions = Field(default_factory=DownloadRestrictions)


class EdrReporterPolicy(BaseModel):
    endpoint: str = "http://localhost:8745/api"
    batch_interval_seconds: int = 30
    max_batch_size: int = 500
    retry_attempts: int = 3
    retry_backoff_ms: int = 1000


class PolicyConfig(BaseModel):
    version: str = "1.0.0"
    updated_at: str = ""
    threat_detection: ThreatDetectionPolicy = Field(default_factory=ThreatDetectionPolicy)
    dlp: DlpPolicy = Field(default_factory=DlpPolicy)
    extension_monitor: ExtensionMonitorPolicy = Field(default_factory=ExtensionMonitorPolicy)
    identity_protection: IdentityProtectionPolicy = Field(default_factory=IdentityProtectionPolicy)
    forensic_logger: ForensicLoggerPolicy = Field(default_factory=ForensicLoggerPolicy)
    governance: GovernancePolicy = Field(default_factory=GovernancePolicy)
    edr_reporter: EdrReporterPolicy = Field(default_factory=EdrReporterPolicy)
