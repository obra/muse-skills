#!/usr/bin/env python3
"""Mechanical proofs for the legacy Python Space rebuild playbook.

The playbook at `~/workspace/spaces/PYTHON_SPACE_MIGRATION.md` owns the
rules; this script owns the two proofs that must never be improvised:

- `snapshot --slug <slug>` runs before anything else. It records a checksum
  manifest of the old Space (excluding files the platform itself may touch),
  prints every database table with its row count, and writes the full data
  dump the builder imports. It never writes inside the old Space; everything
  lands in `~/workspace/migration-<slug>/`.
- `verify --old-slug <a> --new-slug <b>` runs after the rebuild. It re-checks
  the manifest (changed, deleted, and added files all count) and compares
  every table of the old and new databases read-only, in both directions.
  Exit code 0 means MANIFEST CLEAN and ALL MATCH; anything else is a failed
  migration.

Both databases are only ever opened read-only (sqlite `mode=ro`).
"""

import argparse
import hashlib
import os
import sqlite3
import sys
from pathlib import Path

INTERNAL_TABLE_PREFIXES = ("__", "sqlite_", "d1_", "_cf_")
EXCLUDED_COMPONENT_PREFIXES = (".space-build", ".media-generation-staging")
EXCLUDED_NAME_SUFFIXES = ("-journal", "-wal", "-shm")
EXCLUDED_NAMES = ("AGENTS.md",)


def workspace() -> Path:
    return Path(os.environ.get("HOME", str(Path.home()))) / "workspace"


def manifest_lines(root: Path) -> list[str]:
    lines = []
    for path in sorted(root.rglob("*"), key=lambda p: str(p.relative_to(root))):
        if path.is_symlink() or not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(part.startswith(EXCLUDED_COMPONENT_PREFIXES) for part in rel.parts):
            continue
        if rel.name in EXCLUDED_NAMES or rel.name.endswith(EXCLUDED_NAME_SUFFIXES):
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {rel}")
    return lines


def open_ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def app_tables(db: sqlite3.Connection) -> list[str]:
    rows = db.execute("SELECT name FROM sqlite_master WHERE type='table'")
    return sorted(t for (t,) in rows if not t.startswith(INTERNAL_TABLE_PREFIXES))


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def table_count(db: sqlite3.Connection, table: str) -> int:
    return db.execute(f"SELECT COUNT(*) FROM {quote_ident(table)}").fetchone()[0]


def table_digest(db: sqlite3.Connection, table: str) -> str:
    cols = [row[1] for row in db.execute(f"PRAGMA table_info({quote_ident(table)})")]
    order = ", ".join(quote_ident(col) for col in cols)
    digest = hashlib.sha256()
    for row in db.execute(f"SELECT * FROM {quote_ident(table)} ORDER BY {order}"):
        digest.update(repr(row).encode())
    return digest.hexdigest()


def old_db_tables(old_db_path: Path) -> tuple[list[str], bool]:
    """All app tables in the old database, plus whether any holds rows.

    Empty tables still count for verification: a dropped empty table is a
    missing part of the data model, not a no-op.
    """
    if not old_db_path.is_file():
        return [], False
    db = open_ro(old_db_path)
    try:
        tables = app_tables(db)
        populated = any(table_count(db, t) > 0 for t in tables)
        return tables, populated
    finally:
        db.close()


def cmd_snapshot(slug: str) -> int:
    root = workspace() / "spaces" / slug
    if not root.is_dir():
        print(f"ERROR no old Space at {root}", file=sys.stderr)
        return 2
    staging = workspace() / f"migration-{slug}"
    staging.mkdir(exist_ok=True)
    manifest_path = staging / "manifest.before"
    if manifest_path.exists():
        print(
            f"ERROR {manifest_path} already exists; verify against it, or delete "
            "the whole staging directory to start a migration over",
            file=sys.stderr,
        )
        return 2
    manifest_path.write_text("\n".join(manifest_lines(root)) + "\n")
    print(f"manifest: {manifest_path}")

    old_db_path = root / "app.db"
    if not old_db_path.is_file():
        print("no data (app.db missing); skip the data verification step")
        return 0
    db = open_ro(old_db_path)
    try:
        tables = app_tables(db)
        populated = False
        for table in tables:
            count = table_count(db, table)
            populated = populated or count > 0
            print(f"table {table} rows={count}")
        if not populated:
            print("no data (no populated tables); skip the data verification step")
            return 0
        dump_path = staging / "data.sql"
        with open(dump_path, "w") as out:
            for line in db.iterdump():
                out.write(line + "\n")
        print(f"dump: {dump_path}")
    finally:
        db.close()
    return 0


def cmd_verify(old_slug: str, new_slug: str) -> int:
    root = workspace() / "spaces" / old_slug
    staging = workspace() / f"migration-{old_slug}"
    manifest_path = staging / "manifest.before"
    if not manifest_path.is_file():
        print(f"ERROR {manifest_path} missing; snapshot was never taken", file=sys.stderr)
        return 2

    ok = True
    before = {
        line.split("  ", 1)[1]: line.split("  ", 1)[0]
        for line in manifest_path.read_text().splitlines()
        if line.strip()
    }
    after = {
        line.split("  ", 1)[1]: line.split("  ", 1)[0] for line in manifest_lines(root)
    }
    (staging / "manifest.after").write_text(
        "\n".join(f"{digest}  {rel}" for rel, digest in sorted(after.items())) + "\n"
    )
    for rel in sorted(before.keys() - after.keys()):
        print(f"DELETED {rel}")
        ok = False
    for rel in sorted(after.keys() - before.keys()):
        print(f"ADDED {rel}")
        ok = False
    for rel in sorted(before.keys() & after.keys()):
        if before[rel] != after[rel]:
            print(f"CHANGED {rel}")
            ok = False
    print("MANIFEST CLEAN" if ok else "MANIFEST VIOLATED: the old Space was modified")

    old_tables, populated = old_db_tables(root / "app.db")
    if not old_tables or not populated:
        print("no data to verify")
        print("ALL MATCH" if ok else "VERIFICATION FAILED")
        return 0 if ok else 1

    new_db_path = workspace() / "ts-spaces" / new_slug / "app.db"
    if not new_db_path.is_file():
        print(f"MISSING new database {new_db_path}")
        print("VERIFICATION FAILED")
        return 1
    old_db, new_db = open_ro(root / "app.db"), open_ro(new_db_path)
    try:
        new_tables = set(app_tables(new_db))
        for table in old_tables:
            if table not in new_tables:
                print(f"MISSING TABLE {table}")
                ok = False
                continue
            counts = (table_count(old_db, table), table_count(new_db, table))
            match = counts[0] == counts[1] and table_digest(
                old_db, table
            ) == table_digest(new_db, table)
            print(f"{'ok' if match else 'MISMATCH'} {table} rows={counts[0]}/{counts[1]}")
            ok = ok and match
        for table in sorted(new_tables - set(old_tables)):
            if table_count(new_db, table) > 0:
                print(f"EXTRA TABLE {table}")
                ok = False
    finally:
        old_db.close()
        new_db.close()
    print("ALL MATCH" if ok else "VERIFICATION FAILED")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    snapshot = sub.add_parser("snapshot", help="record manifest, counts, and data dump")
    snapshot.add_argument("--slug", required=True)
    verify = sub.add_parser("verify", help="re-check manifest and compare databases")
    verify.add_argument("--old-slug", required=True)
    verify.add_argument("--new-slug", required=True)
    args = parser.parse_args()
    if args.command == "snapshot":
        return cmd_snapshot(args.slug)
    return cmd_verify(args.old_slug, args.new_slug)


if __name__ == "__main__":
    sys.exit(main())
