"""Phase 5 — portable backup/restore. A snapshot must roundtrip every row faithfully: export to a
portable file, then restore into a fresh (or wiped) database and get identical data back."""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.case import Case
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.models.audit_log import AuditLog  # noqa: F401  (ensure tables register)
from app.services.backup_service import export_database, restore_database


class BackupRoundtripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.backup = os.path.join(self.tmp, "snap.sqlite3")
        self.src = create_engine("sqlite:///" + self.tmp.replace("\\", "/") + "/src.sqlite3")
        Base.metadata.create_all(self.src)
        S = sessionmaker(bind=self.src)
        db = S()
        db.add(Case(name="Op Nightfall", description="test"))
        for i in range(25):
            db.add(CDRRecord(case_id="A", a_party_number=f"90000{i:04d}", b_party_number="555",
                             call_type="Voice", tower_id="T1", duration_seconds=i,
                             start_time=datetime(2026, 1, 1, 10, i % 60)))
        for i in range(10):
            db.add(IPDRRecord(case_id="A", source_ip=f"10.0.0.{i}", destination_ip="8.8.8.8",
                              protocol="TCP", start_time=datetime(2026, 1, 1, 11, i)))
        db.add(Tower(tower_id="T1", latitude=19.07, longitude=72.87, city="Mumbai", state="MH"))
        db.commit()
        db.close()

    def tearDown(self):
        self.src.dispose()
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _counts(self, engine):
        S = sessionmaker(bind=engine)
        db = S()
        out = {
            "cases": db.query(func.count(Case.id)).scalar(),
            "cdr": db.query(func.count(CDRRecord.id)).scalar(),
            "ipdr": db.query(func.count(IPDRRecord.id)).scalar(),
            "towers": db.query(func.count(Tower.tower_id)).scalar(),
        }
        db.close()
        return out

    def test_export_counts(self):
        counts = export_database(self.src, self.backup)
        self.assertEqual(counts["cdr_records"], 25)
        self.assertEqual(counts["ipdr_records"], 10)
        self.assertEqual(counts["cases"], 1)
        self.assertTrue(os.path.exists(self.backup))

    def test_roundtrip_into_fresh_db(self):
        export_database(self.src, self.backup)
        dest = create_engine("sqlite:///" + self.tmp.replace("\\", "/") + "/dest.sqlite3")
        Base.metadata.create_all(dest)
        restore_database(dest, self.backup)
        self.assertEqual(self._counts(dest), self._counts(self.src))
        # spot-check content fidelity
        S = sessionmaker(bind=dest); db = S()
        rec = db.query(CDRRecord).filter(CDRRecord.a_party_number == "900000005").one()
        self.assertEqual(rec.duration_seconds, 5)
        self.assertEqual(rec.tower_id, "T1")
        self.assertEqual(db.query(Case).one().name, "Op Nightfall")
        db.close(); dest.dispose()

    def test_restore_replace_wipes_first(self):
        export_database(self.src, self.backup)
        dest = create_engine("sqlite:///" + self.tmp.replace("\\", "/") + "/dest2.sqlite3")
        Base.metadata.create_all(dest)
        S = sessionmaker(bind=dest); db = S()
        db.add(CDRRecord(case_id="OLD", a_party_number="111", b_party_number="222",
                         call_type="Voice", start_time=datetime(2025, 1, 1)))
        db.commit(); db.close()
        # replace must drop the stale row, leaving exactly the snapshot
        restore_database(dest, self.backup, replace=True)
        self.assertEqual(self._counts(dest)["cdr"], 25)
        db = S()
        self.assertEqual(db.query(CDRRecord).filter(CDRRecord.case_id == "OLD").count(), 0)
        db.close(); dest.dispose()


class BackupEndpointAuthTests(unittest.TestCase):
    def test_backup_endpoints_require_auth(self):
        from starlette.testclient import TestClient
        from app.main import app
        c = TestClient(app)
        self.assertEqual(c.post("/backup").status_code, 401)
        self.assertEqual(c.get("/backup").status_code, 401)


if __name__ == "__main__":
    unittest.main()
