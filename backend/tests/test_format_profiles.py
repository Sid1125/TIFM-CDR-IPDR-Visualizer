"""Ingest format profiles: header-signature recognition of known CSV formats, the alias/profile/
override layering in resolve_columns, save/upsert + CRUD endpoints, and the upload-preview
integration that announces a matched format before any data is committed."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.format_profile import IngestFormatProfile
from app.services.auth_service import get_current_user
from app.services.format_profile_service import (
    compute_signature,
    match_profile,
    profile_mapping_for,
    save_profile,
    seed_default_profiles,
)
from app.services.ingest_service import resolve_columns

_HEADERS = ["Phone No", "Peer IP", "Peer Port", "Own IP", "Sess Start", "Sess Length"]
_MAPPING = {
    "msisdn": "Phone No",
    "destination_ip": "Peer IP",
    "destination_port": "Peer Port",
    "source_ip": "Own IP",
    "start_time": "Sess Start",
    "duration_seconds": "Sess Length",
}


class SignatureTests(unittest.TestCase):
    def test_order_and_case_insensitive(self):
        a = compute_signature(["Phone No", "Peer IP", "Sess Start"])
        b = compute_signature(["sess start", "PHONE NO", "peer-ip"])
        self.assertEqual(a, b)

    def test_different_headers_differ(self):
        self.assertNotEqual(compute_signature(["a", "b"]), compute_signature(["a", "c"]))


class ProfileServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def test_save_then_exact_match(self):
        save_profile(self.db, "ipdr", "Test ISP", _HEADERS, _MAPPING, created_by="t")
        m = match_profile(self.db, "ipdr", _HEADERS)
        self.assertIsNotNone(m)
        self.assertEqual(m["match"], "exact")
        self.assertEqual(m["profile"].name, "Test ISP")
        # reordered + re-cased headers still match exactly
        shuffled = [h.upper() for h in reversed(_HEADERS)]
        self.assertEqual(match_profile(self.db, "ipdr", shuffled)["match"], "exact")

    def test_kind_scoping(self):
        save_profile(self.db, "ipdr", "Test ISP", _HEADERS, _MAPPING)
        self.assertIsNone(match_profile(self.db, "cdr", _HEADERS))

    def test_partial_match_when_column_added(self):
        save_profile(self.db, "ipdr", "Test ISP", _HEADERS, _MAPPING)
        m = match_profile(self.db, "ipdr", _HEADERS + ["New Extra Col"])
        self.assertIsNotNone(m)
        self.assertEqual(m["match"], "partial")
        self.assertEqual(m["overlap"], len(_HEADERS))

    def test_no_match_below_threshold(self):
        save_profile(self.db, "ipdr", "Test ISP", _HEADERS, _MAPPING)
        self.assertIsNone(match_profile(self.db, "ipdr", ["totally", "different", "columns"]))

    def test_upsert_updates_not_duplicates(self):
        save_profile(self.db, "ipdr", "Old Name", _HEADERS, _MAPPING)
        save_profile(self.db, "ipdr", "New Name", _HEADERS, dict(_MAPPING, imsi="Phone No"))
        rows = self.db.query(IngestFormatProfile).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].name, "New Name")

    def test_profile_mapping_restricted_to_present_headers(self):
        prof = save_profile(self.db, "ipdr", "Test ISP", _HEADERS, _MAPPING)
        got = profile_mapping_for(prof, ["Phone No", "Peer IP"])  # file lost most columns
        self.assertEqual(got, {"msisdn": "Phone No", "destination_ip": "Peer IP"})

    def test_seed_idempotent_and_matches_dot_format(self):
        self.assertGreaterEqual(seed_default_profiles(self.db), 1)
        self.assertEqual(seed_default_profiles(self.db), 0)  # second run adds nothing
        dot = self.db.query(IngestFormatProfile).filter(
            IngestFormatProfile.created_by == "seed").first()
        self.assertIsNotNone(dot)
        import json
        m = match_profile(self.db, "ipdr", json.loads(dot.headers_json))
        self.assertEqual(m["match"], "exact")


class ResolveLayeringTests(unittest.TestCase):
    def test_profile_beats_alias_override_beats_profile(self):
        cols = ["src_ip", "dst_ip", "session_start", "session_end", "other"]
        # alias alone maps source_ip -> src_ip
        base = resolve_columns(cols, "ipdr")
        self.assertEqual(base["mapping"]["source_ip"], "src_ip")
        self.assertEqual(base["sources"]["source_ip"], "alias")
        # a profile that says source_ip is actually 'other' wins over the alias...
        prof = resolve_columns(cols, "ipdr", profile_mapping={"source_ip": "other"})
        self.assertEqual(prof["mapping"]["source_ip"], "other")
        self.assertEqual(prof["sources"]["source_ip"], "profile")
        # ...and a manual override wins over the profile
        both = resolve_columns(cols, "ipdr", profile_mapping={"source_ip": "other"},
                               override={"source_ip": "src_ip"})
        self.assertEqual(both["mapping"]["source_ip"], "src_ip")
        self.assertEqual(both["sources"]["source_ip"], "override")

    def test_profile_entry_for_absent_header_ignored(self):
        cols = ["src_ip", "dst_ip", "session_start", "session_end"]
        r = resolve_columns(cols, "ipdr", profile_mapping={"source_ip": "not_in_file"})
        self.assertEqual(r["mapping"]["source_ip"], "src_ip")  # alias kept


class ProfileApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

        def _override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = lambda: types.SimpleNamespace(
            username="t", role="admin")
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_save_list_delete_roundtrip(self):
        r = self.client.post("/format-profiles/", json={
            "kind": "ipdr", "name": "Test ISP", "headers": _HEADERS, "mapping": _MAPPING})
        self.assertEqual(r.status_code, 200, r.text)
        pid = r.json()["id"]
        r = self.client.get("/format-profiles/?kind=ipdr")
        names = [p["name"] for p in r.json()["profiles"]]
        self.assertIn("Test ISP", names)
        r = self.client.delete(f"/format-profiles/{pid}")
        self.assertEqual(r.status_code, 200)
        r = self.client.get("/format-profiles/?kind=ipdr")
        self.assertNotIn("Test ISP", [p["name"] for p in r.json()["profiles"]])

    def test_save_rejects_bad_kind_and_empty_mapping(self):
        r = self.client.post("/format-profiles/", json={
            "kind": "nope", "name": "x", "headers": ["a"], "mapping": {"msisdn": "a"}})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/format-profiles/", json={
            "kind": "ipdr", "name": "x", "headers": ["a"], "mapping": {"msisdn": "not_present"}})
        self.assertEqual(r.status_code, 400)

    def test_preview_reports_matched_profile_and_sources(self):
        # save a profile whose mapping deliberately disagrees with what aliases would pick,
        # then confirm the preview applies + reports it
        r = self.client.post("/format-profiles/", json={
            "kind": "ipdr", "name": "Test ISP", "headers": _HEADERS, "mapping": _MAPPING})
        self.assertEqual(r.status_code, 200, r.text)
        csv = ",".join(_HEADERS) + "\n9811099887,1.2.3.4,443,10.0.0.9,2026-01-01 10:00:00,60\n"
        r = self.client.post("/upload/preview",
                             files={"file": ("x.csv", csv, "text/csv")}, data={"kind": "ipdr"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIsNotNone(body["matched_profile"])
        self.assertEqual(body["matched_profile"]["name"], "Test ISP")
        self.assertEqual(body["matched_profile"]["match"], "exact")
        self.assertEqual(body["mapping"]["msisdn"], "Phone No")
        self.assertEqual(body["sources"]["msisdn"], "profile")
        # end_time derivable from start + duration, so nothing required is missing
        self.assertEqual(body["unmapped_required"], [])

    def test_upload_uses_profile_and_bumps_usage(self):
        r = self.client.post("/format-profiles/", json={
            "kind": "ipdr", "name": "Test ISP", "headers": _HEADERS, "mapping": _MAPPING})
        pid = r.json()["id"]
        csv = ",".join(_HEADERS) + "\n9811099887,1.2.3.4,443,10.0.0.9,2026-01-01 10:00:00,60\n"
        r = self.client.post("/upload/ipdr",
                             files={"file": ("x.csv", csv, "text/csv")},
                             data={"case_id": "1", "mode": "replace"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["records_imported"], 1)
        db = self.Session()
        try:
            prof = db.query(IngestFormatProfile).filter(IngestFormatProfile.id == pid).first()
            self.assertEqual(prof.times_used, 1)
            self.assertIsNotNone(prof.last_used)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
