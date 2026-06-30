from sqlalchemy import Column, DateTime, Integer, String, Text, func, Index

from app.core.database import Base


class AuditLog(Base):
    """Chain-of-custody record of an action taken in the tool, so every meaningful event is
    accountable: who did it (username/role), from where (ip), what (action), against which case
    and target, and a JSON detail blob. Append-only — rows are never updated or deleted by the
    application. Distinct from ExportLog (which is export-specific); this covers logins, uploads,
    case create/delete, exports, dossier generation, and case/subject views."""

    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    ts = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    username = Column(String, index=True, nullable=True)   # actor (None for anonymous/failed login)
    role = Column(String, nullable=True)                   # 'admin' | 'investigator' at time of action
    ip_address = Column(String, nullable=True)
    action = Column(String, index=True, nullable=False)    # 'login' | 'login_failed' | 'upload' | 'export' | 'dossier' | 'case_create' | 'case_delete' | 'view_case' | 'view_subject'
    case_id = Column(String, index=True, nullable=True)
    case_name = Column(String, nullable=True)
    target = Column(String, nullable=True)                 # subject id, filename, ref id, etc.
    detail = Column(Text, nullable=True)                   # JSON: extra context for the action
    # Tamper-evidence (Phase 5): each row's entry_hash = sha256(this row's content + prev_hash),
    # forming a chain. Altering or removing any row breaks every hash after it, so the log is
    # verifiable (verify_audit_chain). NULL on legacy rows written before the chain existed.
    prev_hash = Column(String(64), nullable=True)
    entry_hash = Column(String(64), nullable=True, index=True)


# Composite index to make the common Admin-viewer query (recent rows, optionally by user) fast.
Index("ix_audit_ts_user", AuditLog.ts.desc(), AuditLog.username)
