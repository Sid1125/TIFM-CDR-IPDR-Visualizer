"""Background-job status — lets the UI/operator see the async work the event bus enqueues
(analytics (re)materialisation, incremental updates, FTS sync) instead of it being invisible.

Backed by whatever JobQueue the capability layer selected: the self-contained ThreadJobQueue by
default, a Celery/RQ adapter when a broker is configured. Read-only and cheap."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.jobs import get_job_queue
from app.models.auth import User
from app.services.auth_service import get_current_user

router = APIRouter()


@router.get("")
def list_jobs(_user: User = Depends(get_current_user), limit: int = Query(default=50, ge=1, le=200)):
    """Most-recent jobs first, with state (queued/running/done/error) and timings."""
    return get_job_queue().recent(limit=limit)


@router.get("/{job_id}")
def job_status(job_id: str, _user: User = Depends(get_current_user)):
    st = get_job_queue().status(job_id)
    if st is None:
        raise HTTPException(status_code=404, detail="job not found")
    return st
