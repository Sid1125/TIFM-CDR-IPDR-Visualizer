from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Request
from fastapi import Response
from fastapi import status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.auth import AuthSession
from app.models.auth import User
from app.schemas.auth import AdminCreateUserRequest
from app.schemas.auth import AdminResetPasswordRequest
from app.schemas.auth import AdminUpdateUserRequest
from app.schemas.auth import AdminUserListResponse
from app.schemas.auth import AuthLoginResponse
from app.schemas.auth import AuthLogoutResponse
from app.schemas.auth import AuthMeResponse
from app.schemas.auth import AuthSessionListResponse
from app.schemas.auth import AuthSessionRead
from app.schemas.auth import AuthUserRead
from app.schemas.auth import ChangePasswordRequest
from app.schemas.auth import LoginRequest
from app.schemas.auth import PasswordChangeResponse
from app.services.audit_service import log_action
from app.services.auth_service import authenticate_user
from app.services.auth_service import create_session
from app.services.auth_service import get_current_admin
from app.services.auth_service import get_current_session
from app.services.auth_service import hash_password
from app.services.auth_service import normalize_username
from app.services.auth_service import revoke_all_user_sessions
from app.services.auth_service import revoke_session
from app.services.auth_service import verify_password

router = APIRouter()


def _session_is_current(session: AuthSession, current_session: AuthSession) -> bool:
    return session.id == current_session.id


def _serialize_session(session: AuthSession, current_session: AuthSession) -> AuthSessionRead:
    payload = AuthSessionRead.model_validate(session)
    payload.is_current = _session_is_current(session, current_session)
    return payload


@router.post("/login", response_model=AuthLoginResponse)
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    user = authenticate_user(db, payload.username, payload.password)
    if user is None:
        log_action(db, request=request, action="login_failed",
                   username=normalize_username(payload.username or ""),
                   target="invalid credentials")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    session, raw_token = create_session(db, user, request)
    log_action(db, user, request, "login")
    response.set_cookie(
        key=settings.AUTH_SESSION_COOKIE_NAME,
        value=raw_token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=settings.AUTH_SESSION_TTL_HOURS * 60 * 60,
        path="/",
    )

    sessions = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == user.id)
        .order_by(AuthSession.created_at.desc())
        .all()
    )
    return AuthLoginResponse(
        user=AuthUserRead.model_validate(user),
        session=_serialize_session(session, session),
        sessions=[_serialize_session(item, session) for item in sessions],
    )


@router.get("/me", response_model=AuthMeResponse)
def me(session: AuthSession = Depends(get_current_session), db: Session = Depends(get_db)):
    user = session.user
    sessions = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == user.id)
        .order_by(AuthSession.created_at.desc())
        .all()
    )
    return AuthMeResponse(
        user=AuthUserRead.model_validate(user),
        session=_serialize_session(session, session),
        sessions=[_serialize_session(item, session) for item in sessions],
    )


@router.post("/logout", response_model=AuthLogoutResponse)
def logout(
    response: Response,
    session: AuthSession = Depends(get_current_session),
    db: Session = Depends(get_db),
):
    revoke_session(db, session)
    response.delete_cookie(key=settings.AUTH_SESSION_COOKIE_NAME, path="/")
    return AuthLogoutResponse(success=True)


@router.get("/sessions", response_model=AuthSessionListResponse)
def list_sessions(session: AuthSession = Depends(get_current_session), db: Session = Depends(get_db)):
    sessions = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == session.user_id)
        .order_by(AuthSession.created_at.desc())
        .all()
    )
    return AuthSessionListResponse(
        sessions=[_serialize_session(item, session) for item in sessions],
    )


@router.delete("/sessions", response_model=AuthLogoutResponse)
def revoke_everywhere(
    response: Response,
    session: AuthSession = Depends(get_current_session),
    db: Session = Depends(get_db),
):
    revoke_all_user_sessions(db, session.user_id)
    response.delete_cookie(key=settings.AUTH_SESSION_COOKIE_NAME, path="/")
    return AuthLogoutResponse(success=True)


@router.delete("/sessions/{session_id}", response_model=AuthLogoutResponse)
def revoke_one_session(
    session_id: int,
    session: AuthSession = Depends(get_current_session),
    db: Session = Depends(get_db),
):
    target = (
        db.query(AuthSession)
        .filter(AuthSession.id == session_id, AuthSession.user_id == session.user_id)
        .one_or_none()
    )
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    revoke_session(db, target)
    return AuthLogoutResponse(success=True)


@router.post("/password", response_model=PasswordChangeResponse)
def change_password(
    payload: ChangePasswordRequest,
    session: AuthSession = Depends(get_current_session),
    db: Session = Depends(get_db),
):
    user = session.user
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    if len(payload.new_password.strip()) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be at least 8 characters")
    user.password_hash = hash_password(payload.new_password.strip())
    db.commit()
    return PasswordChangeResponse(success=True)


# ── Admin User Management ──

@router.get("/admin/users", response_model=AdminUserListResponse)
def admin_list_users(db: Session = Depends(get_db), admin: User = Depends(get_current_admin)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return AdminUserListResponse(users=[AuthUserRead.model_validate(u) for u in users])


@router.post("/admin/users", status_code=status.HTTP_201_CREATED)
def admin_create_user(
    payload: AdminCreateUserRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    username = normalize_username(payload.username)
    existing = db.query(User).filter(User.username == username).one_or_none()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
    if len(payload.password.strip()) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")
    if payload.role not in ("admin", "investigator"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be 'admin' or 'investigator'")
    user = User(
        username=username,
        password_hash=hash_password(payload.password.strip()),
        role=payload.role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return AuthUserRead.model_validate(user)


@router.put("/admin/users/{user_id}")
def admin_update_user(
    user_id: int,
    payload: AdminUpdateUserRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if payload.role is not None:
        if payload.role not in ("admin", "investigator"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be 'admin' or 'investigator'")
        user.role = payload.role
    if payload.is_active is not None:
        user.is_active = payload.is_active
    db.commit()
    db.refresh(user)
    return AuthUserRead.model_validate(user)


@router.put("/admin/users/{user_id}/password")
def admin_reset_password(
    user_id: int,
    payload: AdminResetPasswordRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if len(payload.new_password.strip()) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")
    user.password_hash = hash_password(payload.new_password.strip())
    db.commit()
    return {"success": True}


@router.delete("/admin/users/{user_id}")
def admin_delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    if user_id == admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account")
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    db.delete(user)
    db.commit()
    return {"success": True}
