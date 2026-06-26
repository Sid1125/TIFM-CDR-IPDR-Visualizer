"""Offline reverse-geocoding for tower coordinates -> nearest Indian city + state.

Fills city/state only where missing (authoritative master data is never overwritten), and is
wired into the tower-repo rebuild so harvested towers get place names automatically.
"""
from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord  # noqa: F401
from app.models.tower import Tower
from app.services.geocode_service import fill_tower, geocode_missing, nearest_city
from app.services.tower_service import rebuild_tower_repo


class GeocodeTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def _db(self):
        return self.Session()

    def test_nearest_city_resolves_state(self):
        # coordinates near known cities resolve to the correct state
        self.assertEqual(nearest_city(19.08, 72.88)[1], "Maharashtra")   # Mumbai
        self.assertEqual(nearest_city(28.62, 77.20)[1], "Delhi")         # New Delhi
        self.assertEqual(nearest_city(13.00, 77.60)[1], "Karnataka")     # Bengaluru
        self.assertEqual(nearest_city(22.57, 88.36)[0], "Kolkata")
        self.assertIsNone(nearest_city(None, None))

    def test_fill_tower_only_fills_missing(self):
        # missing both -> filled
        t = Tower(tower_id="T1", latitude=19.08, longitude=72.88)
        self.assertTrue(fill_tower(t))
        self.assertEqual(t.state, "Maharashtra")
        self.assertTrue(t.city)
        # already named -> untouched, returns False
        t2 = Tower(tower_id="T2", latitude=19.08, longitude=72.88, city="Authoritative", state="X")
        self.assertFalse(fill_tower(t2))
        self.assertEqual(t2.city, "Authoritative")
        self.assertEqual(t2.state, "X")
        # no coordinates -> cannot geocode
        self.assertFalse(fill_tower(Tower(tower_id="T3")))

    def test_geocode_missing_idempotent(self):
        db = self._db()
        db.add_all([
            Tower(tower_id="A", latitude=17.39, longitude=78.49),               # Hyderabad, no name
            Tower(tower_id="B", latitude=26.91, longitude=75.79, city="Jaipur", state="Rajasthan"),
            Tower(tower_id="C"),                                                 # no coords -> skipped
        ])
        db.commit()
        r1 = geocode_missing(db)
        self.assertEqual(r1["filled"], 1)                  # only A
        a = db.query(Tower).get("A")
        self.assertEqual(a.state, "Telangana")
        # second run fills nothing
        self.assertEqual(geocode_missing(db)["filled"], 0)
        self.assertIsNone(db.query(Tower).get("C").state)
        db.close()

    def test_rebuild_geocodes_harvested_towers(self):
        db = self._db()
        db.add_all([
            CDRRecord(case_id="1", a_party_number="X", tower_id="TWR9",
                      latitude=13.08, longitude=80.27),   # Chennai
            CDRRecord(case_id="1", a_party_number="Y", tower_id="TWR9",
                      latitude=13.08, longitude=80.27),
        ])
        db.commit()
        res = rebuild_tower_repo(db)
        self.assertEqual(res["added"], 1)
        self.assertEqual(res["geocoded"], 1)
        t = db.query(Tower).get("TWR9")
        self.assertEqual(t.state, "Tamil Nadu")
        self.assertTrue(t.city)
        db.close()


if __name__ == "__main__":
    unittest.main()
