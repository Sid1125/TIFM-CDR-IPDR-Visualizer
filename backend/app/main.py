from pathlib import Path

from fastapi import Depends
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from app.api.auth import router as auth_router
from app.api.geo import router as geo_router
from app.api.graph import router as graph_router
from app.api.inference import router as inference_router
from app.api.investigation import router as investigation_router
from app.api.watchlist import router as watchlist_router
from app.api.records import router as records_router
from app.api.stats import router as stats_router
from app.api.timeline import router as timeline_router
from app.api.upload import router as upload_router
from app.api.towers import router as towers_router
from app.api.annotations import router as annotations_router
from app.api.subject_tags import router as subject_tags_router
from app.api.cases import router as cases_router
from app.api.cross_case import router as cross_case_router
from app.api.audit import router as audit_router
from app.api.reference import router as reference_router
from app.api.tower_dump import router as tower_dump_router
from app.api.subscribers import router as subscribers_router
from app.api.export import router as export_router
from app.api.ai import router as ai_router
from app.api.analysis import router as analysis_router
from app.api.analytics import router as analytics_router
from app.core.config import settings
from app.core.database import Base
from app.core.database import engine
from app.core.database import SessionLocal
from app.services.auth_service import bootstrap_default_user
from app.services.auth_service import get_current_user
from app.models import cdr  # noqa: F401
from app.models import auth  # noqa: F401
from app.models import ipdr  # noqa: F401
from app.models import tower  # noqa: F401
from app.models import annotation  # noqa: F401
from app.models import subject_tag  # noqa: F401
from app.models import case  # noqa: F401
from app.models import audit_log  # noqa: F401
from app.models import tower_dump  # noqa: F401
from app.models import subscriber  # noqa: F401
from app.models import analytics  # noqa: F401

from fastapi.middleware.gzip import GZipMiddleware

app = FastAPI(title=settings.APP_NAME)
app.add_middleware(GZipMiddleware, minimum_size=1000)


class _StaticCacheMiddleware:
    """Pure-ASGI middleware that only rewrites Cache-Control headers for static
    assets. Unlike a BaseHTTPMiddleware, it never consumes the response body, so
    streaming responses (e.g. /export/records) pass through unbuffered."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if path in ("/static/app.js", "/static/styles.css"):
            cache_value = b"no-cache"
        elif path.startswith("/static/vendor/"):
            cache_value = b"public, max-age=31536000, immutable"
        else:
            return await self.app(scope, receive, send)  # no rewrite, no wrapping

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = [
                    (k, v) for (k, v) in message.get("headers", [])
                    if k.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", cache_value))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(_StaticCacheMiddleware)
static_dir = Path(__file__).resolve().parents[1] / "static"


@app.get("/health")
def health():
    """Health + capability report. `capabilities.self_contained_offline` confirms ARGUS is
    running with no external services (the air-gapped guarantee)."""
    from app.core.capabilities import CAPS
    return {"status": "ok", "capabilities": CAPS.summary()}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(static_dir / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


def _ensure_indexes():
    """Idempotently add the composite indexes to existing databases. create_all() won't alter
    an already-created table, so add them explicitly. CREATE INDEX IF NOT EXISTS is supported by
    both Postgres and SQLite; failures (e.g. older engines) are non-fatal."""
    from sqlalchemy import text
    stmts = [
        # CDR — existing
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_start ON cdr_records (case_id, start_time)",
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_tower ON cdr_records (case_id, tower_id)",
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_aparty ON cdr_records (case_id, a_party_number)",
        # CDR — new: identity queries and b-party joins are blind without these
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_bparty ON cdr_records (case_id, b_party_number)",
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_imsi ON cdr_records (case_id, imsi)",
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_imei ON cdr_records (case_id, imei)",
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_msisdn ON cdr_records (case_id, msisdn)",
        # CDR — co-presence self-join (case_id, tower_id, start_time): the analytics
        # meetings query joins on same tower + same date/hour, so cover all three columns.
        "CREATE INDEX IF NOT EXISTS ix_cdr_case_tower_time ON cdr_records (case_id, tower_id, start_time)",
        # IPDR — existing
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_start ON ipdr_records (case_id, start_time)",
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_tower ON ipdr_records (case_id, tower_id)",
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_srcip ON ipdr_records (case_id, source_ip)",
        # IPDR — new: MSISDN and destination-IP queries hit full-table scan without these
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_msisdn ON ipdr_records (case_id, msisdn)",
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_destip ON ipdr_records (case_id, destination_ip)",
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_imsi ON ipdr_records (case_id, imsi)",
        "CREATE INDEX IF NOT EXISTS ix_ipdr_case_imei ON ipdr_records (case_id, imei)",
        # analytics_cache — case_id already indexed; add key for point lookups
        "CREATE INDEX IF NOT EXISTS ix_analytics_case_key ON analytics_cache (case_id, key)",
    ]
    try:
        with engine.begin() as conn:
            for s in stmts:
                try:
                    conn.execute(text(s))
                except Exception:
                    pass
    except Exception:
        pass


def _ensure_columns():
    """Idempotently add columns introduced after a table already exists (create_all won't ALTER an
    existing table). Failures are non-fatal (e.g. column already present)."""
    from sqlalchemy import text
    stmts = [
        "ALTER TABLE watchlist_entries ADD COLUMN group_name VARCHAR",
        # analytics_cache versioning (Phase 1b)
        "ALTER TABLE analytics_cache ADD COLUMN schema_version INTEGER DEFAULT 0",
        "ALTER TABLE analytics_cache ADD COLUMN record_count INTEGER",
        "ALTER TABLE analytics_cache ADD COLUMN build_ms INTEGER",
    ]
    for s in stmts:
        try:
            with engine.begin() as conn:
                conn.execute(text(s))
        except Exception:
            pass


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    _ensure_indexes()
    _ensure_columns()
    from app.core.capabilities import detect
    detect(engine)  # best-effort probe of optional accelerators; never fatal
    from app.core.events import register_default_handlers
    register_default_handlers()  # wire analytics (re)materialisation to upload events
    # Search acceleration (no-op unless the accelerator is present): create the FTS5 tables /
    # pg_trgm indexes, then bring the FTS index in line with any data already loaded.
    from app.services.search_service import ensure_fts_tables, ensure_pg_trgm_indexes, fts_sync_all
    try:
        ensure_fts_tables(engine)
        ensure_pg_trgm_indexes(engine)
        with SessionLocal() as db:
            fts_sync_all(db)
    except Exception:  # noqa: BLE001 — search acceleration is best-effort, never blocks boot
        import logging
        logging.getLogger(__name__).exception("search index init failed; falling back to ILIKE")
    with SessionLocal() as db:
        bootstrap_default_user(db)


app.include_router(auth_router, prefix="/auth", tags=["Auth"])
app.include_router(geo_router, prefix="/geo", tags=["Geo"], dependencies=[Depends(get_current_user)])
app.include_router(upload_router, prefix="/upload", tags=["Upload"], dependencies=[Depends(get_current_user)])
app.include_router(records_router, prefix="/records", tags=["Records"], dependencies=[Depends(get_current_user)])
app.include_router(towers_router, prefix="/towers", tags=["Towers"], dependencies=[Depends(get_current_user)])
app.include_router(investigation_router, prefix="/investigation", tags=["Investigation"], dependencies=[Depends(get_current_user)])
app.include_router(inference_router, prefix="/inference", tags=["Inference"], dependencies=[Depends(get_current_user)])
app.include_router(watchlist_router, prefix="/watchlist", tags=["Watchlist"], dependencies=[Depends(get_current_user)])
app.include_router(graph_router, prefix="/graph", tags=["Graph"], dependencies=[Depends(get_current_user)])
app.include_router(timeline_router, prefix="/timeline", tags=["Timeline"], dependencies=[Depends(get_current_user)])
app.include_router(stats_router, prefix="/stats", tags=["Statistics"], dependencies=[Depends(get_current_user)])
app.include_router(annotations_router, prefix="/annotations", tags=["Annotations"], dependencies=[Depends(get_current_user)])
app.include_router(subject_tags_router, prefix="/subject-tags", tags=["Subject Tags"], dependencies=[Depends(get_current_user)])
app.include_router(cases_router, prefix="/cases", tags=["Cases"], dependencies=[Depends(get_current_user)])
app.include_router(cross_case_router, prefix="/cross-case", tags=["Cross-case"], dependencies=[Depends(get_current_user)])
app.include_router(audit_router, prefix="/audit", tags=["Audit"], dependencies=[Depends(get_current_user)])
app.include_router(reference_router, prefix="/reference", tags=["Reference"], dependencies=[Depends(get_current_user)])
app.include_router(tower_dump_router, prefix="/tower-dump", tags=["Tower Dump"], dependencies=[Depends(get_current_user)])
app.include_router(subscribers_router, prefix="/subscribers", tags=["Subscribers"], dependencies=[Depends(get_current_user)])
app.include_router(export_router, prefix="/export", tags=["Export"], dependencies=[Depends(get_current_user)])
app.include_router(ai_router, prefix="/ai", tags=["AI"], dependencies=[Depends(get_current_user)])
app.include_router(analysis_router, prefix="/analysis", tags=["Analysis"], dependencies=[Depends(get_current_user)])
app.include_router(analytics_router, prefix="/analytics", tags=["Analytics"], dependencies=[Depends(get_current_user)])
app.mount("/static", StaticFiles(directory=static_dir), name="static")
