from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel
from pydantic import Field


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class AuthUserRead(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None = None

    class Config:
        from_attributes = True


class AuthSessionRead(BaseModel):
    id: int
    created_at: datetime
    expires_at: datetime
    last_seen_at: datetime
    revoked_at: datetime | None = None
    user_agent: str | None = None
    ip_address: str | None = None
    is_current: bool = False

    class Config:
        from_attributes = True


class AuthContextRead(BaseModel):
    user: AuthUserRead
    session: AuthSessionRead


class AuthLoginResponse(AuthContextRead):
    sessions: list[AuthSessionRead] = Field(default_factory=list)


class AuthMeResponse(AuthContextRead):
    sessions: list[AuthSessionRead] = Field(default_factory=list)


class AuthLogoutResponse(BaseModel):
    success: bool = True


class AuthSessionListResponse(BaseModel):
    sessions: list[AuthSessionRead] = Field(default_factory=list)


class PasswordChangeResponse(BaseModel):
    success: bool = True


class AdminCreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "investigator"


class AdminUpdateUserRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None


class AdminResetPasswordRequest(BaseModel):
    new_password: str


class AdminUserListResponse(BaseModel):
    users: list[AuthUserRead] = Field(default_factory=list)
