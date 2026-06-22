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
