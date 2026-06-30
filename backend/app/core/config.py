from functools import lru_cache

try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:  # pragma: no cover - pydantic v1 fallback
    from pydantic import BaseSettings  # type: ignore

    SettingsConfigDict = None  # type: ignore[assignment]


class Settings(BaseSettings):
    # Defaults to a local SQLite file so a fresh clone runs with zero config
    # (`pip install -r requirements.txt` then `uvicorn app.main:app`). Set DATABASE_URL
    # in .env to use PostgreSQL.
    DATABASE_URL: str = "sqlite:///./cdrdb.sqlite3"
    APP_NAME: str = "Project ARGUS"
    AUTH_SESSION_COOKIE_NAME: str = "gpcssi_session"
    AUTH_SESSION_TTL_HOURS: int = 168
    AUTH_BOOTSTRAP_USERNAME: str = "admin"
    AUTH_BOOTSTRAP_PASSWORD: str = "admin12345"
    AUTH_BOOTSTRAP_ROLE: str = "admin"

    # Optional accelerators — ARGUS runs fully offline with these unset (FastAPI + DB only).
    # When set AND reachable, the capability layer (app/core/capabilities.py) opportunistically
    # uses them; if a configured service is unreachable the app silently falls back to the
    # self-contained path. Leave blank for an air-gapped deployment.
    REDIS_URL: str = ""           # e.g. redis://localhost:6379/0 — caching + pub/sub
    CELERY_BROKER_URL: str = ""   # e.g. redis://localhost:6379/1 — background job workers
    ANALYTICS_CACHE_TTL: int = 0  # seconds; 0 = no expiry (DB cache is invalidated by events)

    if SettingsConfigDict is not None:  # pragma: no branch
        model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")
    else:  # pragma: no cover - pydantic v1 fallback
        class Config:
            env_file = ".env"
            env_file_encoding = "utf-8"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
