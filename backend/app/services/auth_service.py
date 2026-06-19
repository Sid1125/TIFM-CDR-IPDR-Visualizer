from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime
from datetime import timedelta

from fastapi import Depends
from fastapi import HTTPException
from fastapi import Request
from fastapi import status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.auth import AuthSession
from app.models.auth import User

PASSWORD_ALGORITHM = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 210_000


def utcnow() -> datetime:
    return datetime.utcnow()


def normalize_username(username: str) -> str:
    return username.strip().lower()


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt_bytes = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_bytes,
        PASSWORD_ITERATIONS,
    )
    salt_text = base64.urlsafe_b64encode(salt_bytes).decode("ascii").rstrip("=")
    digest_text = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"{PASSWORD_ALGORITHM}${PASSWORD_ITERATIONS}${salt_text}${digest_text}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations_text, salt_text, digest_text = stored_hash.split("$", 3)
    except ValueError:
        return False

    if algorithm != PASSWORD_ALGORITHM:
        return False

    try:
        iterations = int(iterations_text)
        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        expected = base64.urlsafe_b64decode(digest_text + "=" * (-len(digest_text) % 4))
    except Exception:
        return False

    candidate = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
    )
    return secrets.compare_digest(candidate, expected)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_client_ip(request: Request) -> str | None:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    client = request.client
    return client.host if client else None


def bootstrap_default_user(db: Session) -> User:
    username = normalize_username(settings.AUTH_BOOTSTRAP_USERNAME)
    user = db.query(User).filter(User.username == username).one_or_none()
    if user is not None:
        return user

    user = User(
        username=username,
        password_hash=hash_password(settings.AUTH_BOOTSTRAP_PASSWORD),
        role=settings.AUTH_BOOTSTRAP_ROLE,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def authenticate_user(db: Session, username: str, password: str) -> User | None:
    user = db.query(User).filter(User.username == normalize_username(username)).one_or_none()
    if user is None or not user.is_active:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def create_session(db: Session, user: User, request: Request) -> tuple[AuthSession, str]:
    raw_token = secrets.token_urlsafe(48)
    now = utcnow()
    session = AuthSession(
        user_id=user.id,
        session_token_hash=hash_session_token(raw_token),
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(hours=settings.AUTH_SESSION_TTL_HOURS),
        user_agent=request.headers.get("user-agent"),
        ip_address=get_client_ip(request),
    )
    user.last_login_at = now
    db.add(session)
    db.commit()
    db.refresh(session)
    return session, raw_token


def revoke_session(db: Session, session: AuthSession) -> None:
    if session.revoked_at is None:
        session.revoked_at = utcnow()
        db.add(session)
        db.commit()


def revoke_all_user_sessions(db: Session, user_id: int) -> int:
    now = utcnow()
    sessions = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .all()
    )
    for session in sessions:
        session.revoked_at = now
    db.commit()
    return len(sessions)


def get_session_from_request(request: Request, db: Session) -> AuthSession:
    token = request.cookies.get(settings.AUTH_SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in")

    token_hash = hash_session_token(token)
    session = (
        db.query(AuthSession)
        .join(User)
        .filter(AuthSession.session_token_hash == token_hash)
        .one_or_none()
    )
    if session is None or session.user is None or not session.user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in")

    now = utcnow()
    if session.revoked_at is not None or session.expires_at <= now:
        if session.revoked_at is None:
            session.revoked_at = now
            db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")

    session.last_seen_at = now
    session.expires_at = now + timedelta(hours=settings.AUTH_SESSION_TTL_HOURS)
    db.commit()
    db.refresh(session)
    return session


def get_current_session(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthSession:
    return get_session_from_request(request, db)


def get_current_user(session: AuthSession = Depends(get_current_session)) -> User:
    return session.user

def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user
