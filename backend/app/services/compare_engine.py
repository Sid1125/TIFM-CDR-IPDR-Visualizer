"""CompareEngine — generic multi-subject comparison across pluggable data adapters.

Architecture
------------
CompareAdapter (ABC)
  ├── CDRCompareAdapter   — contacts, towers, cells, lat/lng, IMEIs, call matrix
  └── IPDRCompareAdapter  — destination IPs, towers, protocols, APNs

CompareEngine([CDRCompareAdapter(...), IPDRCompareAdapter(...)], subjects)
  .compare() → merged result dict with sections from all adapters

Extending: implement a new CompareAdapter subclass; CompareEngine picks it up
without any changes to the API or the existing adapters.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.services.reference_service import lookup_imei, lookup_number


# ── abstract adapter ───────────────────────────────────────────────────────────

class CompareAdapter(ABC):
    def __init__(self, db: Session, case_id: str | None) -> None:
        self.db = db
        self.case_id = case_id

    @property
    @abstractmethod
    def source_type(self) -> str:
        """'CDR' or 'IPDR' — used as section-name prefix for non-CDR adapters."""

    @abstractmethod
    def contacts(self, subject: str) -> set:
        """All counterparts the subject communicated with."""

    @abstractmethod
    def locations(self, subject: str) -> set:
        """Tower IDs seen for this subject (as owner/initiator)."""

    @abstractmethod
    def identifiers(self, subject: str) -> dict[str, set]:
        """Named sets of identifiers for intersection.
        CDR: {imeis, imsis, cells, latlng}
        IPDR: {protocols, apns, rats}
        """

    @abstractmethod
    def matrix_sections(self, subjects: list[str]) -> dict:
        """Sections that compare across pairs (e.g. call matrix).
        Return {} if not applicable for this adapter."""


# ── CDR adapter ────────────────────────────────────────────────────────────────

class CDRCompareAdapter(CompareAdapter):
    @property
    def source_type(self) -> str:
        return "CDR"

    def _inv(self, subject: str, *cols):
        q = self.db.query(*cols).filter(
            or_(CDRRecord.a_party_number == subject, CDRRecord.b_party_number == subject)
        )
        return q.filter(CDRRecord.case_id == self.case_id) if self.case_id else q

    def _own(self, subject: str, *cols):
        q = self.db.query(*cols).filter(CDRRecord.a_party_number == subject)
        return q.filter(CDRRecord.case_id == self.case_id) if self.case_id else q

    def contacts(self, subject: str) -> set:
        result: set = set()
        for a, b in self._inv(subject, CDRRecord.a_party_number, CDRRecord.b_party_number).all():
            if a and str(a) != subject:
                result.add(str(a))
            if b and str(b) != subject:
                result.add(str(b))
        return result

    def locations(self, subject: str) -> set:
        return {
            str(r[0])
            for r in self._own(subject, CDRRecord.tower_id)
            .filter(CDRRecord.tower_id.isnot(None))
            .distinct()
            .all()
        }

    def identifiers(self, subject: str) -> dict[str, set]:
        imeis: set = set()
        imsis: set = set()
        cells: set = set()
        latlng: set = set()
        for row in (
            self._own(subject, CDRRecord.imei, CDRRecord.imsi, CDRRecord.cell_id,
                      CDRRecord.latitude, CDRRecord.longitude)
            .all()
        ):
            if row[0]:
                imeis.add(str(row[0]))
            if row[1]:
                imsis.add(str(row[1]))
            if row[2]:
                cells.add(str(row[2]))
            if row[3] is not None and row[4] is not None:
                latlng.add(f"{round(float(row[3]), 3)},{round(float(row[4]), 3)}")
        return {"imeis": imeis, "imsis": imsis, "cells": cells, "latlng": latlng}

    def matrix_sections(self, subjects: list[str]) -> dict:
        matrix = []
        for a in subjects:
            for b in subjects:
                if a == b:
                    continue
                q = self.db.query(func.count(CDRRecord.id)).filter(
                    CDRRecord.a_party_number == a, CDRRecord.b_party_number == b
                )
                if self.case_id:
                    q = q.filter(CDRRecord.case_id == self.case_id)
                k = q.scalar() or 0
                if k:
                    matrix.append([a, b, k])
        return {"matrix": {"headers": ["Caller", "Called", "Direct calls"], "rows": matrix}}


# ── IPDR adapter ───────────────────────────────────────────────────────────────

class IPDRCompareAdapter(CompareAdapter):
    @property
    def source_type(self) -> str:
        return "IPDR"

    def _iq(self, subject: str, *cols):
        q = self.db.query(*cols).filter(
            or_(IPDRRecord.source_ip == subject, IPDRRecord.msisdn == subject)
        )
        return q.filter(IPDRRecord.case_id == self.case_id) if self.case_id else q

    def contacts(self, subject: str) -> set:
        q = self.db.query(IPDRRecord.destination_ip).filter(
            IPDRRecord.source_ip == subject, IPDRRecord.destination_ip.isnot(None)
        )
        if self.case_id:
            q = q.filter(IPDRRecord.case_id == self.case_id)
        return {str(r[0]) for r in q.distinct().limit(2000).all()}

    def locations(self, subject: str) -> set:
        return {
            str(r[0])
            for r in self._iq(subject, IPDRRecord.tower_id)
            .filter(IPDRRecord.tower_id.isnot(None))
            .distinct()
            .all()
        }

    def identifiers(self, subject: str) -> dict[str, set]:
        protocols: set = set()
        apns: set = set()
        rats: set = set()
        for row in (
            self._iq(subject, IPDRRecord.protocol, IPDRRecord.apn, IPDRRecord.rat)
            .distinct()
            .all()
        ):
            if row[0]:
                protocols.add(str(row[0]))
            if row[1]:
                apns.add(str(row[1]))
            if row[2]:
                rats.add(str(row[2]))
        return {"protocols": protocols, "apns": apns, "rats": rats}

    def matrix_sections(self, subjects: list[str]) -> dict:
        return {}  # IPDR has no call/session matrix equivalent


# ── compare engine ─────────────────────────────────────────────────────────────

class CompareEngine:
    def __init__(self, adapters: list[CompareAdapter], subjects: list[str]) -> None:
        self.adapters = adapters
        self.subjects = subjects

    def _intersect(self, sets_by_subject: dict[str, set]) -> list:
        acc: set | None = None
        for s in self.subjects:
            acc = set(sets_by_subject[s]) if acc is None else acc & sets_by_subject[s]
        return sorted(acc or [])

    def compare(self) -> dict:
        result: dict = {}

        for adapter in self.adapters:
            # Per-subject data collection
            contacts_map = {s: adapter.contacts(s) for s in self.subjects}
            locations_map = {s: adapter.locations(s) for s in self.subjects}
            ids_map = {s: adapter.identifiers(s) for s in self.subjects}

            common_contacts = [c for c in self._intersect(contacts_map) if c not in self.subjects]
            common_locations = self._intersect(locations_map)

            # Intersect each identifier dimension
            all_id_keys: set = set()
            for id_dict in ids_map.values():
                all_id_keys.update(id_dict.keys())
            common_ids = {
                k: self._intersect({s: ids_map[s].get(k, set()) for s in self.subjects})
                for k in all_id_keys
            }

            if adapter.source_type == "CDR":
                # Keep CDR sections at root level (backward compat with existing frontend)
                contacts_rows = []
                for c in common_contacts:
                    ref = lookup_number(c)
                    contacts_rows.append([c, ref.get("operator") or "—", ref.get("circle") or "—"])

                imei_rows = []
                for imei in common_ids.get("imeis", []):
                    ref = lookup_imei(imei)
                    mm = ((ref.get("make") or "") + " " + (ref.get("model") or "")).strip() or "—"
                    imei_rows.append([imei, mm])

                result["contacts"] = {
                    "headers": ["Common contact", "Operator", "Circle"], "rows": contacts_rows,
                }
                result["towers"] = {
                    "headers": ["Common tower"], "rows": [[t] for t in common_locations],
                }
                result["cells"] = {
                    "headers": ["Common cell ID"],
                    "rows": [[c] for c in common_ids.get("cells", [])],
                }
                result["latlng"] = {
                    "headers": ["Common location (lat,lng ~110m)"],
                    "rows": [[l] for l in common_ids.get("latlng", [])],
                }
                result["imeis"] = {
                    "headers": ["Common IMEI", "Make / Model"], "rows": imei_rows,
                }

            else:
                # Non-CDR adapters get a source_type prefix so they don't collide
                pfx = adapter.source_type.lower() + "_"
                result[f"{pfx}towers"] = {
                    "headers": ["Common IPDR tower"], "rows": [[t] for t in common_locations],
                }
                result[f"{pfx}contacts"] = {
                    "headers": ["Common destination IP"],
                    "rows": [[c] for c in common_contacts[:200]],
                }
                result[f"{pfx}protocols"] = {
                    "headers": ["Common protocol"],
                    "rows": [[p] for p in common_ids.get("protocols", [])],
                }
                if common_ids.get("apns"):
                    result[f"{pfx}apns"] = {
                        "headers": ["Common APN"],
                        "rows": [[a] for a in common_ids["apns"]],
                    }

            # Merge pair sections (e.g. call matrix from CDR)
            result.update(adapter.matrix_sections(self.subjects))

        return result
