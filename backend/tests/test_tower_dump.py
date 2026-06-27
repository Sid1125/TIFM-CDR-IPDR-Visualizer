"""Tower-dump import + analysis: a number present across multiple dumps surfaces as 'common',
single-dump numbers are 'uncommon', and SIM/IMEI multiplicity is detected."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.tower_dump import TowerDumpRecord  # noqa: F401
from app.models.tower import Tower  # noqa: F401
from app.services.auth_service import get_current_user


def _dump_csv(rows):
    head = "msisdn,imei,start_time,tower_id\n"
    return head + "".join(rows)


class TowerDumpTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

        def _override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = lambda: types.SimpleNamespace(username="t", role="admin")
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def _import(self, label, rows):
        return self.client.post(
            "/upload/tower-dump",
            files={"file": (label + ".csv", _dump_csv(rows), "text/csv")},
            data={"case_id": "1", "dump_label": label, "mode": "replace"},
        )

    def test_common_and_uncommon(self):
        # 999 is at both scenes; 111 only at scene A, 222 only at scene B.
        a = self._import("SceneA", [
            "999,IMEI1,2026-01-01 10:00:00,TWR_A\n",
            "111,IMEI1,2026-01-01 10:01:00,TWR_A\n",
        ])
        b = self._import("SceneB", [
            "999,IMEI2,2026-01-02 12:00:00,TWR_B\n",
            "222,IMEI3,2026-01-02 12:05:00,TWR_B\n",
        ])
        self.assertEqual(a.status_code, 200, a.text)
        self.assertEqual(b.status_code, 200, b.text)

        common = self.client.get("/tower-dump/common", params={"case_id": "1", "labels": "SceneA,SceneB", "min": 2}).json()
        nums = [r["msisdn"] for r in common["rows"]]
        self.assertIn("999", nums)
        self.assertNotIn("111", nums)
        self.assertEqual(common["rows"][0]["dump_count"], 2)

        uncommon = self.client.get("/tower-dump/uncommon", params={"case_id": "1", "labels": "SceneA,SceneB"}).json()
        unums = sorted(r["msisdn"] for r in uncommon["rows"])
        self.assertEqual(unums, ["111", "222"])

    def test_multiplicity_and_dumps_list(self):
        self._import("SceneA", ["999,IMEI1,2026-01-01 10:00:00,TWR_A\n"])
        self._import("SceneB", ["999,IMEI2,2026-01-02 12:00:00,TWR_B\n"])
        mult = self.client.get("/tower-dump/multiplicity", params={"case_id": "1", "labels": "SceneA,SceneB"}).json()
        # 999 used two IMEIs across the dumps
        self.assertTrue(any(x["msisdn"] == "999" and len(x["imeis"]) == 2 for x in mult["imeis_per_sim"]))

        dumps = self.client.get("/tower-dump/dumps", params={"case_id": "1"}).json()
        self.assertEqual(len(dumps), 2)
        self.assertEqual({d["dump_label"] for d in dumps}, {"SceneA", "SceneB"})

    def test_replace_mode_clears_same_label(self):
        self._import("SceneA", ["999,IMEI1,2026-01-01 10:00:00,TWR_A\n", "111,IMEI1,2026-01-01 10:01:00,TWR_A\n"])
        self._import("SceneA", ["888,IMEI9,2026-01-03 09:00:00,TWR_A\n"])  # replace
        ut = self.client.get("/tower-dump/under-tower", params={"case_id": "1", "label": "SceneA"}).json()
        nums = {r["msisdn"] for r in ut["rows"]}
        self.assertEqual(nums, {"888"})


if __name__ == "__main__":
    unittest.main()
