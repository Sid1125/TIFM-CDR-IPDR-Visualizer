"""Backup / restore the ARGUS database to a portable file (Phase 5).

    python -m scripts.backup --export  backups/argus_2026-06-30.sqlite3
    python -m scripts.backup --restore backups/argus_2026-06-30.sqlite3 --replace

Works on both PostgreSQL and SQLite deployments with no external tool. The snapshot is a single
portable SQLite file containing every table — keep it secure (it includes credential hashes and
the audit log). --restore without --replace appends; with --replace it empties the target first.
"""
from __future__ import annotations

import argparse
import sys

from app.core.database import engine
from app.services.backup_service import export_database, restore_database


def main() -> int:
    ap = argparse.ArgumentParser(description="Portable ARGUS DB backup / restore.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--export", metavar="PATH", help="write a snapshot to PATH")
    g.add_argument("--restore", metavar="PATH", help="load a snapshot from PATH into the live DB")
    ap.add_argument("--replace", action="store_true",
                    help="with --restore: empty the target tables first (full restore)")
    args = ap.parse_args()

    try:
        if args.export:
            counts = export_database(engine, args.export)
            total = sum(counts.values())
            print(f"Exported {total} rows across {len(counts)} tables to {args.export}")
            for name, n in counts.items():
                if n:
                    print(f"  {name}: {n}")
            return 0
        else:
            if args.replace:
                print("WARNING: --replace will empty the live tables before loading the snapshot.")
            counts = restore_database(engine, args.restore, replace=args.replace)
            total = sum(counts.values())
            print(f"Restored {total} rows across {len(counts)} tables from {args.restore}")
            return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
