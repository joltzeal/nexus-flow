from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    app_name: str = "Nexus Flow"
    api_host: str = "127.0.0.1"
    api_port: int = 8765
    api_reload: bool = False
    mode: str = "production"

    bitbrowser_base_url: str = Field(
        default="http://127.0.0.1:54345",
        description="BitBrowser Local Server base URL.",
    )
    bitbrowser_timeout_seconds: float = 30.0
    adspower_base_url: str = Field(
        default="http://127.0.0.1:50325",
        description="AdsPower Local API base URL.",
    )
    adspower_timeout_seconds: float = 30.0
    adspower_api_key: str = ""

    model_config = SettingsConfigDict(
        env_file=(PROJECT_DIR / ".env", BACKEND_DIR / ".env"),
        env_prefix="NEXUS_FLOW_",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.mode = settings.mode.strip().lower()
    if settings.mode not in {"development", "production"}:
        raise ValueError("NEXUS_FLOW_MODE must be 'development' or 'production'.")
    return settings
