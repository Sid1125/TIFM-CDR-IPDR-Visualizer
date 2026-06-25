"""Permanent tower repository: auto-harvest from CDR/IPDR ingest + repo stats/search.

The `towers` table is global (keyed by tower_id, no case_id), so towers accumulate across every
case. Uploads grow it from the rows' own tower_id+lat/lng without clobbering existing metadata.
"""
from __future__ import annotations

import unittest

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.upload import _harvest_towers
from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.tower_service import rebuild_tower_repo, tower_repo_list, tower_repo_stats


class TowerRepoTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def _db(self):
        return self.Session()

    def test_harvest_inserts_new_and_backfills_without_clobbering(self):
        db = self._db()
        # pre-existing tower with full metadata but NO coordinates
        db.add(Tower(tower_id="TWR1", latitude=None, longitude=None, city="Delhi", state="DL"))
        db.commit()
        df = pd.DataFrame([
            {"tower_id": "TWR1", "latitude": 28.6, "longitude": 77.2},   # backfill coords, keep city/state
            {"tower_id": "TWR2", "latitude": 19.0, "longitude": 72.8},   # brand new
            {"tower_id": "TWR2", "latitude": 19.0, "longitude": 72.8},   # dup -> collapsed
            {"tower_id": "TWR3", "latitude": None, "longitude": None},   # new, no coords
        ])
        added = _harvest_towers(db, df)
        db.commit()
        self.assertEqual(added, 2)  # TWR2, TWR3
        t1 = db.query(Tower).get("TWR1")
        self.assertAlmostEqual(t1.latitude, 28.6)      # backfilled
        self.assertEqual(t1.city, "Delhi")             # NOT clobbered
        self.assertEqual(t1.state, "DL")
        self.assertEqual(db.query(Tower).count(), 3)
        db.close()

    def test_harvest_does_not_overwrite_existing_coords(self):
        db = self._db()
        db.add(Tower(tower_id="TWR1", latitude=1.0, longitude=2.0, city="X", state="Y"))
        db.commit()
        _harvest_towers(db, pd.DataFrame([{"tower_id": "TWR1", "latitude": 9.9, "longitude": 9.9}]))
        db.commit()
        t1 = db.query(Tower).get("TWR1")
        self.assertEqual((t1.latitude, t1.longitude), (1.0, 2.0))  # original coords retained
        db.close()

    def test_harvest_handles_missing_tower_column(self):
        db = self._db()
        self.assertEqual(_harvest_towers(db, pd.DataFrame([{"a_party_number": "9"}])), 0)
        db.close()

    def test_repo_stats_and_search(self):
        db = self._db()
        db.add_all([
            Tower(tower_id="MH1", latitude=19.0, longitude=72.8, city="Mumbai", state="MH"),
            Tower(tower_id="MH2", latitude=18.5, longitude=73.8, city="Pune", state="MH"),
            Tower(tower_id="DL1", latitude=None, longitude=None, city="Delhi", state="DL"),
        ])
        db.commit()
        st = tower_repo_stats(db)
        self.assertEqual(st["total"], 3)
        self.assertEqual(st["with_coords"], 2)
        self.assertEqual(st["without_coords"], 1)
        self.assertEqual(st["states_covered"], 2)
        self.assertEqual(st["by_state"][0], {"state": "MH", "count": 2})
        # search by state
        res = tower_repo_list(db, search="MH")
        self.assertEqual(res["total"], 2)
        self.assertTrue(all(r["state"] == "MH" for r in res["rows"]))
        # search by tower id
        self.assertEqual(tower_repo_list(db, search="DL1")["total"], 1)
        db.close()


    def test_rebuild_from_records_backfills_coords(self):
        db = self._db()
        # a tower registered without coordinates (e.g. from an id-only master)
        db.add(Tower(tower_id="T1", latitude=None, longitude=None, city="Mumbai", state="MH"))
        # records that DO carry coordinates for T1 and an unregistered T2
        db.add_all([
            CDRRecord(case_id="1", a_party_number="A", tower_id="T1", latitude=19.0, longitude=72.8),
            IPDRRecord(case_id="1", source_ip="1.2.3.4", tower_id="T2", latitude=28.6, longitude=77.2),
        ])
        db.commit()
        res = rebuild_tower_repo(db)
        self.assertEqual(res["added"], 1)     # T2 created
        self.assertEqual(res["updated"], 1)   # T1 coords filled
        t1 = db.query(Tower).get("T1")
        self.assertAlmostEqual(t1.latitude, 19.0)
        self.assertEqual(t1.city, "Mumbai")   # preserved
        self.assertEqual(res["total"], 2)
        db.close()


if __name__ == "__main__":
    unittest.main()
