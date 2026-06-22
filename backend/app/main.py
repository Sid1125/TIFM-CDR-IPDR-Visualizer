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
from app.api.cases import router as cases_router
from app.api.ai import router as ai_router
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
from app.models import case  # noqa: F401

app = FastAPI(title=settings.APP_NAME)
static_dir = Path(__file__).resolve().parents[1] / "static"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(static_dir / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
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
app.include_router(cases_router, prefix="/cases", tags=["Cases"], dependencies=[Depends(get_current_user)])
app.include_router(ai_router, prefix="/ai", tags=["AI"], dependencies=[Depends(get_current_user)])
app.mount("/static", StaticFiles(directory=static_dir), name="static")
