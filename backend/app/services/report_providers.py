"""Provider pattern for per-subject analysis reports.

Hierarchy
---------
DataProvider (ABC)
  ├── CDRProvider   — loads raw CDR rows; per-subject counts are small
  └── IPDRProvider  — uses SQL aggregations; per-subject IPDR can be 50k+ rows

Usage
-----
  CDRProvider(db, case_id, subject).build_report()
  IPDRProvider(db, case_id, subject).build_report()

Adding a new source (e.g., toll records) means implementing a new subclass with
four abstract methods (volume_by_day, hourly_pattern, tower_footprint, off_periods)
plus specific_sections() — the shared pipeline picks them up automatically.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import Integer, cast, extract, func, or_
from sqlalchemy.orm import Session

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.services.reference_service import lookup_imei, lookup_number


# ── shared helpers ─────────────────────────────────────────────────────────────

def _d(v) -> str:
    if v is None:
        return ""
    return v.strftime("%Y-%m-%d") if hasattr(v, "strftime") else str(v)


def _ts(v) -> str | None:
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _hm(v) -> str:
    return v.strftime("%H:%M") if v and hasattr(v, "strftime") else ""


def _dur_str(secs) -> str:
    if secs is None:
        return ""
    s = int(secs)
    h, m, s = s // 3600, (s % 3600) // 60, s % 60
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def _is_isd_num(num: str | None) -> bool:
    if not num:
        return False
    n = str(num).strip()
    if n.startswith("+") or n.startswith("00"):
        return True
    d = "".join(c for c in n if c.isdigit())
    return len(d) < 10


# ── abstract base ──────────────────────────────────────────────────────────────

class DataProvider(ABC):
    """Abstract data provider for one subject.  Subclass for each source type."""

    def __init__(self, db: Session, case_id: str | None, subject: str) -> None:
        self.db = db
        self.case_id = case_id
        self.subject = subject

    # ── identity ───────────────────────────────────────────────────────────────

    @property
    @abstractmethod
    def subject_type(self) -> str:
        """'CDR' or 'IPDR' — reported in the response so the UI can label sections."""

    @abstractmethod
    def total_records(self) -> int: ...

    # ── shared sections (all providers implement these) ────────────────────────

    @abstractmethod
    def volume_by_day(self) -> dict:
        """Daily record / session count.
        Returns {"headers": [...], "rows": [[date, count], ...]}
        """

    @abstractmethod
    def hourly_pattern(self) -> dict:
        """Records/sessions by hour of day (0–23).
        Returns {"headers": [...], "rows": [[hour_label, count], ...]}
        """

    @abstractmethod
    def tower_footprint(self) -> dict:
        """Most-used towers for this subject.
        Returns {"headers": [...], "rows": [[tower_id, count], ...]}
        """

    @abstractmethod
    def off_periods(self) -> dict:
        """Gaps ≥ 3 days of silence.
        Returns {"headers": [...], "rows": [[last_seen, reappeared, gap], ...]}
        """

    # ── provider-specific sections ─────────────────────────────────────────────

    @abstractmethod
    def specific_sections(self) -> dict[str, dict]:
        """Additional sections only meaningful for this data type.
        Returns {section_key: {"headers": [...], "rows": [...]}, ...}
        """

    # ── report assembly ────────────────────────────────────────────────────────

    def build_report(self) -> dict:
        n = self.total_records()
        if not n:
            return {
                "total_records": 0,
                "subject": self.subject,
                "subject_type": self.subject_type,
                "reports": {},
            }
        shared = {
            "daily_volume": self.volume_by_day(),
            "hourly_pattern": self.hourly_pattern(),
            "tower_footprint": self.tower_footprint(),
            "off_periods": self.off_periods(),
        }
        return {
            "total_records": n,
            "subject": self.subject,
            "subject_type": self.subject_type,
            "reports": {**shared, **self.specific_sections()},
        }


# ── CDR provider ──────────────────────────────────────────────────────────────

class CDRProvider(DataProvider):
    """CDR report provider.  Loads all records for the subject into memory
    (per-subject CDR counts are typically small) then derives all sections in one
    pass over the loaded list."""

    def __init__(self, db: Session, case_id: str | None, subject: str) -> None:
        super().__init__(db, case_id, subject)
        self._records: list | None = None

    @property
    def subject_type(self) -> str:
        return "CDR"

    @property
    def _all(self) -> list:
        if self._records is None:
            q = self.db.query(CDRRecord).filter(
                or_(
                    CDRRecord.a_party_number == self.subject,
                    CDRRecord.b_party_number == self.subject,
                )
            )
            if self.case_id:
                q = q.filter(CDRRecord.case_id == self.case_id)
            self._records = q.order_by(CDRRecord.start_time).all()
        return self._records

    @property
    def _owned(self) -> list:
        return [r for r in self._all if r.a_party_number == self.subject and r.start_time]

    def _other(self, r: CDRRecord) -> str:
        return (r.b_party_number or "") if r.a_party_number == self.subject else (r.a_party_number or "")

    def _is_sms(self, r: CDRRecord) -> bool:
        ct = (r.call_type or "").lower()
        return "sms" in ct or "text" in ct

    def total_records(self) -> int:
        return len(self._all)

    def volume_by_day(self) -> dict:
        by_day: defaultdict = defaultdict(int)
        for r in self._all:
            if r.start_time:
                by_day[r.start_time.strftime("%Y-%m-%d")] += 1
        rows = [[d, by_day[d]] for d in sorted(by_day)]
        return {"headers": ["Date", "Records"], "rows": rows}

    def hourly_pattern(self) -> dict:
        buckets = [0] * 24
        for r in self._all:
            if r.start_time:
                buckets[r.start_time.hour] += 1
        rows = [[f"{h:02d}:00", buckets[h]] for h in range(24) if buckets[h]]
        return {"headers": ["Hour", "Records"], "rows": rows}

    def tower_footprint(self) -> dict:
        cnt: defaultdict = defaultdict(int)
        for r in self._owned:
            if r.tower_id:
                cnt[r.tower_id] += 1
        rows = [[t, n] for t, n in sorted(cnt.items(), key=lambda x: x[1], reverse=True)[:20]]
        return {"headers": ["Tower", "Records"], "rows": rows}

    def off_periods(self) -> dict:
        with_ts = [r for r in self._all if r.start_time]
        rows = []
        for i in range(1, len(with_ts)):
            gap = (with_ts[i].start_time - with_ts[i - 1].start_time).total_seconds() / 86400
            if gap >= 3:
                rows.append([_ts(with_ts[i - 1].start_time), _ts(with_ts[i].start_time), f"{gap:.1f} days"])
        return {"headers": ["Last seen", "Reappeared", "Gap"], "rows": rows}

    def specific_sections(self) -> dict[str, dict]:
        sub = self.subject
        inv_raw = self._all
        owned = self._owned

        # group by day
        by_day: defaultdict = defaultdict(list)
        for r in inv_raw:
            if r.start_time:
                by_day[r.start_time.strftime("%Y-%m-%d")].append(r)
        days = sorted(by_day)

        # day_first_last
        dayfl = []
        for d in days:
            rs = sorted(by_day[d], key=lambda r: r.start_time)
            f, l = rs[0], rs[-1]
            dayfl.append([
                d,
                _hm(f.start_time) + " → " + (self._other(f) or "?"),
                _hm(l.start_time) + " → " + (self._other(l) or "?"),
                len(rs),
            ])

        # single_call_days
        single = []
        for d in days:
            if len(by_day[d]) == 1:
                r = by_day[d][0]
                single.append([d, _hm(r.start_time), self._other(r) or "?",
                                "SMS" if self._is_sms(r) else "Call"])

        # weekday_weekend
        dow_js = [0] * 7
        for r in inv_raw:
            if r.start_time:
                dow_js[(r.start_time.weekday() + 1) % 7] += 1
        dnames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        wk = [[dnames[i], dow_js[i]] for i in range(7)]
        wk.append(["— Weekday total", sum(dow_js[1:6])])
        wk.append(["— Weekend total", dow_js[0] + dow_js[6]])

        # longest_calls
        calls = sorted(
            (r for r in inv_raw if not self._is_sms(r) and r.duration_seconds is not None and r.start_time),
            key=lambda r: r.duration_seconds, reverse=True,
        )[:30]
        longest = [[_ts(r.start_time), self._other(r) or "?", _dur_str(r.duration_seconds), r.tower_id or ""]
                   for r in calls]

        # day_night
        d_cnt = n_cnt = 0
        d_tow: defaultdict = defaultdict(int)
        n_tow: defaultdict = defaultdict(int)
        for r in inv_raw:
            if r.start_time:
                if 6 <= r.start_time.hour < 18:
                    d_cnt += 1
                else:
                    n_cnt += 1
        for r in owned:
            if r.start_time and r.tower_id:
                if 6 <= r.start_time.hour < 18:
                    d_tow[r.tower_id] += 1
                else:
                    n_tow[r.tower_id] += 1

        def _top_tow(m: dict) -> str:
            if not m:
                return "—"
            top = max(m.items(), key=lambda x: x[1])
            return f"{top[0]} ({top[1]})"

        dn = [
            ["Day (06:00–18:00)", d_cnt, _top_tow(dict(d_tow))],
            ["Night (18:00–06:00)", n_cnt, _top_tow(dict(n_tow))],
        ]

        # isd_calls
        isd = []
        for r in inv_raw:
            oth = self._other(r)
            if oth and _is_isd_num(oth) and r.start_time:
                ref = lookup_number(oth)
                isd.append([_ts(r.start_time), oth, ref.get("country") or "Unknown",
                             "SMS" if self._is_sms(r) else "Call"])

        # other_state
        sub_ref = lookup_number(sub)
        sub_circle = sub_ref.get("circle")
        ostate = []
        for r in inv_raw:
            oth = self._other(r)
            if oth and r.start_time:
                ref = lookup_number(oth)
                oc = ref.get("circle")
                if oc and oc != sub_circle:
                    ostate.append([_ts(r.start_time), oth, oc])

        # imei_summary
        imei_map: defaultdict = defaultdict(lambda: {"first": None, "last": None, "c": 0})
        for r in owned:
            if r.imei:
                m = imei_map[r.imei]
                m["c"] += 1
                if r.start_time:
                    if m["first"] is None or r.start_time < m["first"]:
                        m["first"] = r.start_time
                    if m["last"] is None or r.start_time > m["last"]:
                        m["last"] = r.start_time
        imei_rows = []
        for k, m in imei_map.items():
            ref = lookup_imei(k)
            mm = ((ref.get("make") or "") + " " + (ref.get("model") or "")).strip() or "—"
            imei_rows.append([k, mm, _ts(m["first"]), _ts(m["last"]), m["c"]])

        # imsi_summary
        imsi_cnt: defaultdict = defaultdict(int)
        for r in owned:
            if r.imsi:
                imsi_cnt[r.imsi] += 1
        imsi_rows = [[k, v] for k, v in sorted(imsi_cnt.items(), key=lambda x: x[1], reverse=True)]

        # bank_sms
        bank = []
        for r in inv_raw:
            oth = self._other(r) or ""
            if self._is_sms(r) and r.start_time and any(c.isalpha() for c in oth):
                bank.append([_ts(r.start_time), oth, "SMS"])

        return {
            "day_first_last": {"headers": ["Date", "First call", "Last call", "Records"], "rows": dayfl,
                               "sub_circle": sub_circle},
            "single_call_days": {"headers": ["Date", "Time", "Contact", "Type"], "rows": single},
            "weekday_weekend": {"headers": ["Day", "Records"], "rows": wk},
            "longest_calls": {"headers": ["Time", "Contact", "Duration", "Tower"], "rows": longest},
            "day_night": {"headers": ["Bucket", "Records", "Dominant tower"], "rows": dn},
            "isd_calls": {"headers": ["Time", "Number", "Country", "Type"], "rows": isd},
            "other_state": {
                "headers": ["Time", "Number", "Circle"], "rows": ostate,
                "note": f"Subject circle: {sub_circle}" if sub_circle else "Subject circle unknown",
            },
            "imei_summary": {"headers": ["IMEI", "Make / Model", "First", "Last", "Records"], "rows": imei_rows},
            "imsi_summary": {"headers": ["IMSI", "Records"], "rows": imsi_rows},
            "bank_sms": {"headers": ["Time", "Sender", "Type"], "rows": bank},
        }

    def build_report(self) -> dict:
        n = self.total_records()
        if not n:
            empty: dict = {"headers": [], "rows": [], "note": ""}
            sub_ref = lookup_number(self.subject)
            return {
                "total_records": 0,
                "subject": self.subject,
                "subject_type": self.subject_type,
                "sub_circle": sub_ref.get("circle"),
                "reports": {k: dict(empty) for k in [
                    "daily_volume", "hourly_pattern", "tower_footprint", "off_periods",
                    "day_first_last", "single_call_days", "weekday_weekend", "longest_calls",
                    "day_night", "isd_calls", "other_state", "imei_summary", "imsi_summary", "bank_sms",
                ]},
            }
        shared = {
            "daily_volume": self.volume_by_day(),
            "hourly_pattern": self.hourly_pattern(),
            "tower_footprint": self.tower_footprint(),
            "off_periods": self.off_periods(),
        }
        specific = self.specific_sections()
        # Surface sub_circle at top level for backward compat with existing frontend
        sub_circle = specific.get("day_first_last", {}).get("sub_circle")
        if sub_circle is not None:
            specific["day_first_last"].pop("sub_circle", None)
        return {
            "total_records": n,
            "subject": self.subject,
            "subject_type": self.subject_type,
            "sub_circle": sub_circle,
            "reports": {**shared, **specific},
        }


# ── IPDR provider ──────────────────────────────────────────────────────────────

class IPDRProvider(DataProvider):
    """IPDR report provider.  All sections use SQL aggregations — never loads
    raw IPDR rows into Python (a subject may have 50 k+ sessions)."""

    @property
    def subject_type(self) -> str:
        return "IPDR"

    def _q(self, *cols):
        q = self.db.query(*cols).filter(
            or_(IPDRRecord.source_ip == self.subject, IPDRRecord.msisdn == self.subject)
        )
        return q.filter(IPDRRecord.case_id == self.case_id) if self.case_id else q

    def total_records(self) -> int:
        return self._q(func.count(IPDRRecord.id)).scalar() or 0

    def volume_by_day(self) -> dict:
        rows = []
        for row in (
            self._q(
                func.date(IPDRRecord.start_time).label("d"),
                func.count(IPDRRecord.id).label("n"),
                func.sum(IPDRRecord.bytes_uploaded).label("up"),
                func.sum(IPDRRecord.bytes_downloaded).label("dn"),
            )
            .filter(IPDRRecord.start_time.isnot(None))
            .group_by(func.date(IPDRRecord.start_time))
            .order_by(func.date(IPDRRecord.start_time))
            .all()
        ):
            up = int(row.up or 0)
            dn = int(row.dn or 0)
            rows.append([_d(row.d), row.n,
                         f"{up/1024/1024:.2f} MB", f"{dn/1024/1024:.2f} MB",
                         f"{(up+dn)/1024/1024:.2f} MB"])
        return {"headers": ["Date", "Sessions", "Upload", "Download", "Total"], "rows": rows}

    def hourly_pattern(self) -> dict:
        buckets = [0] * 24
        for row in (
            self._q(
                cast(extract("hour", IPDRRecord.start_time), Integer).label("h"),
                func.count(IPDRRecord.id).label("n"),
            )
            .filter(IPDRRecord.start_time.isnot(None))
            .group_by(cast(extract("hour", IPDRRecord.start_time), Integer))
            .all()
        ):
            h = int(row.h or 0)
            if 0 <= h < 24:
                buckets[h] = row.n
        rows = [[f"{h:02d}:00", buckets[h]] for h in range(24) if buckets[h]]
        return {"headers": ["Hour", "Sessions"], "rows": rows}

    def tower_footprint(self) -> dict:
        rows = [
            [str(r[0]), r[1]]
            for r in self._q(IPDRRecord.tower_id, func.count(IPDRRecord.id))
            .filter(IPDRRecord.tower_id.isnot(None))
            .group_by(IPDRRecord.tower_id)
            .order_by(func.count(IPDRRecord.id).desc())
            .limit(20)
            .all()
        ]
        return {"headers": ["Tower", "Sessions"], "rows": rows}

    def off_periods(self) -> dict:
        all_dates = sorted({
            _d(r[0])
            for r in self._q(func.date(IPDRRecord.start_time))
            .filter(IPDRRecord.start_time.isnot(None))
            .distinct()
            .all()
            if r[0]
        })
        rows = []
        for i in range(1, len(all_dates)):
            try:
                gap = (
                    datetime.strptime(all_dates[i], "%Y-%m-%d")
                    - datetime.strptime(all_dates[i - 1], "%Y-%m-%d")
                ).days
                if gap >= 3:
                    rows.append([all_dates[i - 1], all_dates[i], gap])
            except ValueError:
                pass
        return {"headers": ["Last active", "Resumed", "Gap (days)"], "rows": rows}

    def specific_sections(self) -> dict[str, dict]:
        total = self.total_records()

        # protocol_breakdown
        proto_rows = [
            [str(r[0]), r[1], f"{r[1]/total*100:.1f}%"]
            for r in self._q(IPDRRecord.protocol, func.count(IPDRRecord.id))
            .filter(IPDRRecord.protocol.isnot(None))
            .group_by(IPDRRecord.protocol)
            .order_by(func.count(IPDRRecord.id).desc())
            .all()
        ]

        # top_destinations (source sessions only — avoid polluting with transit)
        dest_q = self.db.query(IPDRRecord.destination_ip, func.count(IPDRRecord.id).label("n"))
        if self.case_id:
            dest_q = dest_q.filter(IPDRRecord.case_id == self.case_id)
        dest_q = dest_q.filter(
            IPDRRecord.source_ip == self.subject, IPDRRecord.destination_ip.isnot(None)
        )
        top_dest = [
            [str(r[0]), r[1]]
            for r in dest_q.group_by(IPDRRecord.destination_ip)
            .order_by(func.count(IPDRRecord.id).desc())
            .limit(30)
            .all()
        ]

        # data_throughput by day
        tput_rows = [
            [_d(r[0]), f"{int(r[1] or 0)/1024/1024:.2f} MB", f"{int(r[2] or 0)/1024/1024:.2f} MB"]
            for r in self._q(
                func.date(IPDRRecord.start_time),
                func.sum(IPDRRecord.bytes_uploaded),
                func.sum(IPDRRecord.bytes_downloaded),
            )
            .filter(IPDRRecord.start_time.isnot(None))
            .group_by(func.date(IPDRRecord.start_time))
            .order_by(func.date(IPDRRecord.start_time))
            .all()
        ]

        # port_usage
        port_rows = [
            [str(r[0]), str(r[1] or ""), r[2]]
            for r in self._q(
                IPDRRecord.destination_port, IPDRRecord.protocol, func.count(IPDRRecord.id)
            )
            .filter(IPDRRecord.destination_port.isnot(None))
            .group_by(IPDRRecord.destination_port, IPDRRecord.protocol)
            .order_by(func.count(IPDRRecord.id).desc())
            .limit(30)
            .all()
        ]

        # apn_breakdown
        apn_rows = [
            [str(r[0]), r[1], f"{r[1]/total*100:.1f}%"]
            for r in self._q(IPDRRecord.apn, func.count(IPDRRecord.id))
            .filter(IPDRRecord.apn.isnot(None))
            .group_by(IPDRRecord.apn)
            .order_by(func.count(IPDRRecord.id).desc())
            .all()
        ]

        # rat_breakdown
        rat_rows = [
            [str(r[0]), r[1], f"{r[1]/total*100:.1f}%"]
            for r in self._q(IPDRRecord.rat, func.count(IPDRRecord.id))
            .filter(IPDRRecord.rat.isnot(None))
            .group_by(IPDRRecord.rat)
            .order_by(func.count(IPDRRecord.id).desc())
            .all()
        ]

        return {
            "protocol_breakdown": {"headers": ["Protocol", "Sessions", "% of total"], "rows": proto_rows},
            "top_destinations": {"headers": ["Destination IP", "Sessions"], "rows": top_dest},
            "data_throughput": {"headers": ["Date", "Upload", "Download"], "rows": tput_rows},
            "port_usage": {"headers": ["Dest port", "Protocol", "Sessions"], "rows": port_rows},
            "apn_breakdown": {"headers": ["APN", "Sessions", "% of total"], "rows": apn_rows},
            "rat_breakdown": {"headers": ["RAT", "Sessions", "% of total"], "rows": rat_rows},
        }
