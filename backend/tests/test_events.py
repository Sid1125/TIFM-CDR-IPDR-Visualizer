"""Phase 1d — the in-process event bus. publish() must reach every subscriber, isolate handler
failures, and the default registration must wire the analytics (re)materialisation handlers."""
from __future__ import annotations

import unittest

from app.core import events


class EventBusTests(unittest.TestCase):
    def setUp(self):
        events.clear()

    def tearDown(self):
        events.clear()

    def test_publish_reaches_subscribers_with_payload(self):
        got = []
        events.subscribe("evt", lambda **d: got.append(d))
        events.publish("evt", case_id="A", n=3)
        self.assertEqual(got, [{"case_id": "A", "n": 3}])

    def test_handler_failure_is_isolated(self):
        calls = []
        events.subscribe("evt", lambda **_: (_ for _ in ()).throw(RuntimeError("boom")))
        events.subscribe("evt", lambda **_: calls.append(1))
        events.publish("evt")  # must not raise despite the first handler throwing
        self.assertEqual(calls, [1])  # the second handler still ran

    def test_duplicate_subscribe_is_idempotent(self):
        calls = []
        h = lambda **_: calls.append(1)
        events.subscribe("evt", h)
        events.subscribe("evt", h)
        events.publish("evt")
        self.assertEqual(calls, [1])

    def test_register_default_handlers_wires_upload_events(self):
        events.clear()
        events.register_default_handlers()
        self.assertIn(events._on_case_imported, events._subscribers[events.CASE_IMPORTED])
        self.assertIn(events._on_records_appended, events._subscribers[events.RECORDS_APPENDED])
        # CASE_IMPORTED drives both materialisation and the FTS index refresh.
        self.assertIn(events._on_data_changed_search, events._subscribers[events.CASE_IMPORTED])
        before = len(events._subscribers[events.CASE_IMPORTED])
        events.register_default_handlers()  # idempotent — no duplicate handlers
        self.assertEqual(len(events._subscribers[events.CASE_IMPORTED]), before)

    def test_case_imported_handler_enqueues_a_job(self):
        # Patch the queue + materialize so we exercise wiring without a DB.
        import app.core.events as ev
        enq = {}

        class FakeQ:
            def enqueue(self, func, *a, name="", **k):
                enq["name"] = name
                return "job1"

        import app.core.jobs as jobs
        saved = jobs.get_job_queue
        jobs.get_job_queue = lambda: FakeQ()
        try:
            ev._on_case_imported(case_id="CASE_X")
        finally:
            jobs.get_job_queue = saved
        self.assertIn("materialize:CASE_X", enq.get("name", ""))


if __name__ == "__main__":
    unittest.main()
