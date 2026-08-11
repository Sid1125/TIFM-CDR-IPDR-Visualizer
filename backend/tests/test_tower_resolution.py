"""Tower key normalization and coordinate resolution: differently punctuated CGIs must join the
tower repository, geo records must inherit repo coordinates when the record itself has none, and
meetings/entities must treat punctuation variants of one cell as the same place."""
from __future__ import annotations

import types
import unittest
from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.cdr import CDRRecord
from app.models.tower import Tower
from app.services.auth_service import get_current_user
from app.utils.tower_key import norm_tower_key


class NormTowerKeyTests(unittest.TestCase):
    def test_variants_collapse(self):
        for v in ("404-10-1234-5678", "40410 1234 5678", "404.10.1234.5678", "40410-12345678"):
            self.assertEqual(norm_tower_key(v), "404101234567" + "8")

    def test_case_and_none(self):
        self.assertEqual(norm_tower_key("abC-1"), "ABC1")
        self.assertIsNone(norm_tower_key(None))
        self.assertIsNone(norm_tower_key("---"))


class GeoResolutionTests(unittest.TestCase):
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

    def test_coordless_record_resolves_via_normalized_tower(self):
        db = self.Session()
        try:
            # repo key normalized (as the towers upload now stores it)
            db.add(Tower(tower_id="40410123456781", latitude=28.6, longitude=77.2))
            # record carries the SAME cell in DoT punctuation, and no coordinates
            db.add(CDRRecord(case_id="1", a_party_number="111", b_party_number="222",
                             tower_id="404-10-1234567-81",
                             start_time=datetime(2026, 1, 1, 10, 0, 0)))
            db.commit()
        finally:
            db.close()
        r = self.client.get("/geo/records?case_id=1")
        self.assertEqual(r.status_code, 200, r.text)
        rows = r.json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["latitude"], 28.6)
        self.assertEqual(rows[0]["longitude"], 77.2)
        self.assertIsNotNone(rows[0]["tower"])

    def test_unresolvable_tower_still_skipped(self):
        db = self.Session()
        try:
            db.add(Tower(tower_id="9999", latitude=10.0, longitude=10.0))
            db.add(CDRRecord(case_id="1", a_party_number="111", b_party_number="222",
                             tower_id="404-77-0000-0001",  # not in repo
                             start_time=datetime(2026, 1, 1, 10, 0, 0)))
            db.commit()
        finally:
            db.close()
        r = self.client.get("/geo/records?case_id=1")
        self.assertEqual(r.json(), [])

    def test_meetings_match_across_punctuation(self):
        from app.services.investigation_service import find_meetings
        db = self.Session()
        try:
            db.add(CDRRecord(case_id="1", a_party_number="111", b_party_number="900",
                             tower_id="404-10-1-2", start_time=datetime(2026, 1, 1, 10, 0)))
            db.add(CDRRecord(case_id="1", a_party_number="222", b_party_number="901",
                             tower_id="40410 1 2", start_time=datetime(2026, 1, 1, 10, 5)))
            db.commit()
            res = find_meetings(db, case_id="1", window_min=60)
            self.assertEqual(res["total"], 1)
            self.assertEqual({res["meetings"][0]["subject_a"], res["meetings"][0]["subject_b"]},
                             {"111", "222"})
        finally:
            db.close()


class TowerForeignKeyTests(unittest.TestCase):
    """cdr_records.tower_id / ipdr_records.tower_id are foreign keys onto towers.tower_id, so the
    repository must hold each tower id EXACTLY as the records spell it. Normalizing on write (as
    an earlier revision did) uppercased '4058640ca8a4010' and broke the constraint on PostgreSQL.
    SQLite skips FK enforcement unless asked, so this suite turns it on explicitly."""

    def setUp(self):
        from sqlalchemy import event

        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _fk_on(dbapi_conn, _rec):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        # production seeds these at startup; the DoT IPDR profile is what maps First CELL ID
        # onto tower_id (the key every location engine — and this FK — depends on)
        from app.services.format_profile_service import seed_default_profiles
        db = self.Session()
        try:
            seed_default_profiles(db)
        finally:
            db.close()

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

    # The real DoT IPDR export header plus the Latitude/Longitude columns an investigator can
    # embed — i.e. exactly the file shape that hit the constraint in production.
    _HEADERS = [
        "Landline/MSISDN/MDN/Leased Circuit ID for Internet Access",
        "User Id for internet Access based on authentication",
        "Source IP Address", "Source Port", "Translated IP Address", "Translated Port",
        "Destination IP Address", "Destination Port", "Static/Dynamic IP Address Allocation",
        "IST Start Time of Public IP address allocation (hh:mm:ss)",
        "IST End Time of Public IP address allocation (hh:mm:ss)",
        "Start Date of Public IP Address allocation (dd/mm/yyyy)",
        "End Date of Public IP address allocation (dd/mm/yyyy)",
        "Source MAC-ID Address/Other device Identification number",
        "IMSI", "PGW IP address", "Access Point Name", "First CELL ID", "Last CELL ID",
        "TIME1 (dd/MM/yyyy HH:mm:ss)", "Session Duration (Seconds)",
        "Data Volume Up Link", "Data Volume Down Link",
        "Roaming Circle Indicator", "Roaming Circle", "SIM Type",
        "Latitude", "Longitude",
    ]

    @classmethod
    def _csv(cls) -> str:
        def row(cell_id, lat, lon):
            return ",".join([
                "919834402127", "9.19834E+11", "10.0.0.1", "47648", "152.59.6.113", "47648",
                "129.227.29.207", "443", "DYNAMIC", "8:53:26", "9:14:32", "4/6/2026", "4/6/2026",
                "8.6397E+14", "4.05864E+14", "2405:200:5205:29::6", "", cell_id, cell_id,
                "4/6/2026 8:57", "152", "227368", "353779", "HOME", "Maharashtra", "",
                lat, lon,
            ])
        return "\n".join([
            ",".join(cls._HEADERS),
            # lowercase hex id — normalization would uppercase it and break the FK
            row("4058640ca8a4010", "29.3675", "76.982852"),
            # punctuated id — normalization would strip the dashes and break the FK
            row("404-8640c-511c001", "28.776677", "76.104659"),
        ]) + "\n"

    def test_lowercase_and_punctuated_tower_ids_satisfy_fk(self):
        r = self.client.post("/upload/ipdr",
                             files={"file": ("ipdr.csv", self._csv(), "text/csv")},
                             data={"case_id": "1", "mode": "replace"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["records_imported"], 2)
        db = self.Session()
        try:
            # the repository holds the ids exactly as the records spell them
            repo = {t.tower_id for t in db.query(Tower).all()}
            self.assertEqual(repo, {"4058640ca8a4010", "404-8640c-511c001"})
            from app.models.ipdr import IPDRRecord
            recs = {r.tower_id for r in db.query(IPDRRecord).all()}
            self.assertTrue(recs <= repo, f"records reference ids missing from towers: {recs - repo}")
        finally:
            db.close()

    def test_tower_master_upload_keeps_raw_ids(self):
        csv = "tower_id,latitude,longitude,city\n404-10-1234-5678,28.6,77.2,Delhi\n"
        r = self.client.post("/upload/towers", files={"file": ("t.csv", csv, "text/csv")})
        self.assertEqual(r.status_code, 200, r.text)
        db = self.Session()
        try:
            t = db.query(Tower).one()
            self.assertEqual(t.tower_id, "404-10-1234-5678")
        finally:
            db.close()


class AnalyticsUpsertRaceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def test_concurrent_upsert_same_key_no_unique_violation(self):
        from app.services.analytics_materialize_service import _upsert, get_cached
        # two sessions write the same (case, key) — the loser of the old SELECT-then-INSERT
        # race; with native upsert both succeed, last writer wins
        s1, s2 = self.Session(), self.Session()
        try:
            _upsert(s1, "12", "dashboard", {"v": 1})
            _upsert(s2, "12", "dashboard", {"v": 2})  # would have IntegrityError'd before
            s1.commit()
            s2.commit()
            s3 = self.Session()
            try:
                self.assertIn(get_cached(s3, "12", "dashboard"), ({"v": 1}, {"v": 2}))
            finally:
                s3.close()
        finally:
            s1.close()
            s2.close()


if __name__ == "__main__":
    unittest.main()
