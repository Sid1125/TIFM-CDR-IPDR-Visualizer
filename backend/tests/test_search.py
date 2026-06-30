"""Phase 3c — FTS5 trigram search must return exactly what the ILIKE scan would (substring,
case-insensitive, across the searched columns), stay in sync across appends, and fall back to
ILIKE for sub-trigram (<3 char) terms. Parity is asserted by running each query both ways."""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.core.capabilities import detect, CAPS
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower  # noqa: F401
from app.services.records_service import page_records
from app.services import search_service as ss


class FtsSearchTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        detect(self.engine)  # sets CAPS.sqlite_fts5 from this build
        self.assertTrue(CAPS.sqlite_fts5, "this SQLite build lacks FTS5; test environment issue")
        ss.ensure_fts_tables(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        rows = [
            ("9811112222", "9822223333", "TWRA"),
            ("9833334444", "9811119999", "TWRB"),
            ("7000000001", "8000000002", "TWRA"),
        ]
        for i, (a, b, twr) in enumerate(rows):
            db.add(CDRRecord(case_id="A", a_party_number=a, b_party_number=b, call_type="Voice",
                             tower_id=twr, start_time=datetime(2026, 1, 1, 10, i)))
        db.add(IPDRRecord(case_id="A", source_ip="10.0.0.5", destination_ip="142.250.1.1",
                          protocol="TCP", tower_id="TWRA", start_time=datetime(2026, 1, 1, 11, 0)))
        db.commit()
        ss.fts_sync_all(db)
        db.close()

    def _ids(self, db, search):
        res = page_records(db, case_id="A", rtype="all", search=search, limit=500)
        return sorted((o, r.id) for o, r in zip(res["order"], res["rows"]))

    def _parity(self, search):
        db = self.Session()
        CAPS.sqlite_fts5 = False           # ILIKE baseline
        ilike = self._ids(db, search)
        CAPS.sqlite_fts5 = True            # FTS path
        fts = self._ids(db, search)
        db.close()
        self.assertEqual(fts, ilike, f"FTS vs ILIKE mismatch for search={search!r}")
        return fts

    def tearDown(self):
        CAPS.sqlite_fts5 = True  # leave consistent

    def test_partial_number_substring(self):
        # "9811" appears as a substring of two a/b-party numbers across two rows.
        hits = self._parity("9811")
        self.assertEqual(len(hits), 2)

    def test_full_number(self):
        self._parity("9833334444")

    def test_tower_substring(self):
        self._parity("TWRA")  # 2 CDR + 1 IPDR

    def test_ip_substring(self):
        self._parity("142.250")

    def test_case_insensitive(self):
        self._parity("twra")

    def test_no_match(self):
        self.assertEqual(self._parity("zzzznope"), [])

    def test_short_term_falls_back_to_ilike(self):
        # "98" is < 3 chars → trigram can't index it → must use ILIKE and still return matches.
        db = self.Session()
        self.assertTrue(CAPS.sqlite_fts5)
        hits = self._ids(db, "98")   # FTS-enabled, but clause should fall back to ILIKE internally
        db.close()
        self.assertTrue(len(hits) >= 2)

    def test_append_then_sync_picks_up_new_rows(self):
        db = self.Session()
        db.add(CDRRecord(case_id="A", a_party_number="9899998888", b_party_number="1",
                         call_type="Voice", tower_id="TWRC", start_time=datetime(2026, 1, 2, 9, 0)))
        db.commit()
        # before sync: FTS doesn't know the new row yet
        self.assertEqual(self._ids(db, "9899998888"), [])
        ss.fts_sync_all(db)
        self.assertEqual(len(self._ids(db, "9899998888")), 1)
        db.close()

    def test_fts_sync_prunes_deleted_rows(self):
        db = self.Session()
        db.query(CDRRecord).filter(CDRRecord.a_party_number == "9833334444").delete()
        db.commit()
        ss.fts_sync_all(db)
        self.assertEqual(self._ids(db, "9833334444"), [])
        db.close()


if __name__ == "__main__":
    unittest.main()
