"""Application configuration via environment variables."""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    host: str = "127.0.0.1"
    port: int = 8745
    db_path: str = "phoenix_edr.db"
    policy_path: str = "phoenix_agent/policies/default_policy.json"
    retention_days: int = 7
    log_level: str = "INFO"
    cors_origins: list[str] = ["chrome-extension://*", "http://localhost:*"]
    rate_limit_per_minute: int = 100

    model_config = {"env_prefix": "PHOENIX_"}


settings = Settings()
