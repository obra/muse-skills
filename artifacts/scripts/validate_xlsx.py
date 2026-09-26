#!/usr/bin/env python3
"""Acceptance check for a generated spreadsheet: does it actually open, and does it hold data?

Every other file artifact kind reads its output back before delivery (PDF through
validate_pdf.sh, decks through render_audit.mjs). Spreadsheets had no equivalent, so a
workbook that cannot be opened — or that carries nothing but headers — reached the user
with the builder still reporting success.

The core checks use only the standard library, so this runs anywhere the builder runs.
openpyxl is used as an extra reader when it happens to be importable, because that is the
library the workbook was almost certainly written with.

usage: validate_xlsx.py <file.xlsx> [--json-out <path>] [--allow-empty]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

SPREADSHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


RELATIONSHIP_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PACKAGE_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def normalize_part(target: str) -> str:
    """Resolve a workbook-relative relationship target to a zip member path."""
    target = target.lstrip("/")
    if target.startswith("xl/"):
        return target
    return "xl/" + target.removeprefix("./")


def declared_sheets(zf: zipfile.ZipFile) -> list[tuple[str, str | None]]:
    """Each sheet the workbook declares, paired with the part it points at.

    A declared sheet whose part is absent is the failure this pairing exists to
    surface: counting worksheet files alone would miss it, and comparing counts
    alone would misjudge a workbook that legitimately carries a chartsheet.
    """
    try:
        root = ET.fromstring(zf.read("xl/workbook.xml"))
    except (KeyError, ET.ParseError):
        return []

    targets: dict[str, str] = {}
    try:
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    except (KeyError, ET.ParseError):
        rels = None
    if rels is not None:
        for rel in rels.iter(f"{PACKAGE_REL_NS}Relationship"):
            rid, target = rel.get("Id"), rel.get("Target")
            if rid and target:
                targets[rid] = normalize_part(target)

    sheets: list[tuple[str, str | None]] = []
    for i, el in enumerate(root.iter(f"{SPREADSHEET_NS}sheet")):
        name = el.get("name") or f"Sheet{i + 1}"
        rid = el.get(f"{RELATIONSHIP_NS}id") or el.get("r:id")
        sheets.append((name, targets.get(rid) if rid else None))
    return sheets


def sheet_stats(zf: zipfile.ZipFile, path: str) -> dict:
    """Count populated cells and formulas in one worksheet part.

    Raises on unreadable XML rather than reporting zeros: a sheet that will not
    parse is the failure being looked for, and zeros would make it look blank.
    """
    populated = 0
    formulas = 0
    max_row = 0
    max_col = 0
    root = ET.fromstring(zf.read(path))
    for cell in root.iter(f"{SPREADSHEET_NS}c"):
        has_formula = cell.find(f"{SPREADSHEET_NS}f") is not None
        value = cell.find(f"{SPREADSHEET_NS}v")
        inline = cell.find(f"{SPREADSHEET_NS}is")
        if not (has_formula or value is not None or inline is not None):
            continue
        populated += 1
        if has_formula:
            formulas += 1
        ref = cell.get("r") or ""
        match = re.match(r"([A-Z]+)(\d+)", ref)
        if match:
            letters, digits = match.groups()
            col = 0
            for ch in letters:
                col = col * 26 + (ord(ch) - ord("A") + 1)
            max_col = max(max_col, col)
            max_row = max(max_row, int(digits))
    return {
        "populated_cells": populated,
        "formulas": formulas,
        "rows": max_row,
        "columns": max_col,
    }


def openpyxl_readback(path: str) -> dict:
    """Reopen with the canonical writer library when it is installed."""
    try:
        import openpyxl  # noqa: PLC0415
    except ImportError:
        return {"ran": False, "reason": "openpyxl not installed"}
    try:
        book = openpyxl.load_workbook(path)
    except Exception as err:  # noqa: BLE001 - any reader failure is the signal
        return {"ran": True, "ok": False, "error": f"{type(err).__name__}: {err}"}
    return {"ran": True, "ok": True, "sheets": list(book.sheetnames)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="the .xlsx file to check")
    parser.add_argument("--json-out", help="also write the summary as JSON here")
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="permit a workbook with no populated cells (a deliberately blank template)",
    )
    args = parser.parse_args()

    try:
        with open(args.path, "rb") as handle:
            head = handle.read(4)
    except OSError as err:
        fail(f"cannot read {args.path}: {err}")
    if not head:
        fail(f"file is empty: {args.path}")
    # A zip always starts "PK". Text or CSV bytes written to a .xlsx name land here.
    if not head.startswith(b"PK"):
        preview = head.decode("utf-8", "replace")
        fail(
            f"not an OOXML workbook (starts with {preview!r}, expected a zip). "
            "Text or CSV written to a .xlsx name cannot be opened as a spreadsheet: "
            "write it with a real spreadsheet library, or name it .csv."
        )

    try:
        zf = zipfile.ZipFile(args.path)
    except zipfile.BadZipFile as err:
        fail(f"corrupt workbook, not a readable zip: {err}")
    with zf:
        if zf.testzip() is not None:
            fail("corrupt workbook: a zip member failed its CRC check")
        names = zf.namelist()
        if "xl/workbook.xml" not in names:
            fail("missing xl/workbook.xml, so this zip is not a spreadsheet")

        declared = declared_sheets(zf)
        if not declared:
            fail("workbook declares no sheets")
        sheets = [name for name, _ in declared]

        member_set = set(names)
        per_sheet = []
        for name, part in declared:
            if part is None or part not in member_set:
                fail(f"sheet {name!r} points at a part that is not in the file ({part})")
            if not part.startswith("xl/worksheets/"):
                continue  # a chartsheet or dialogsheet: it exists, it just holds no cells
            try:
                per_sheet.append(sheet_stats(zf, part))
            except ET.ParseError as err:
                fail(f"sheet {name!r} ({part}) is not readable XML: {err}")
        summary = {
            "path": args.path,
            "sheets": sheets,
            "sheet_count": len(sheets),
            "populated_cells": sum(s["populated_cells"] for s in per_sheet),
            "formulas": sum(s["formulas"] for s in per_sheet),
            "per_sheet": per_sheet,
            "has_chart": any("chart" in n for n in names),
            "has_images": any(n.startswith("xl/media/") for n in names),
            "openpyxl": openpyxl_readback(args.path),
        }

    readback = summary["openpyxl"]
    if readback.get("ran") and not readback.get("ok"):
        fail(f"openpyxl could not open the workbook: {readback['error']}")

    if summary["populated_cells"] == 0 and not args.allow_empty:
        fail(
            "workbook opens but every sheet is empty. Deliver real content, "
            "or pass --allow-empty when a blank template is what was asked for."
        )

    print(f"OK: opens as a workbook, {summary['sheet_count']} sheet(s): {', '.join(sheets)}")
    print(
        f"OK: {summary['populated_cells']} populated cells, "
        f"{summary['formulas']} formulas, chart={summary['has_chart']}"
    )
    if readback.get("ran"):
        print("OK: reopened with openpyxl")
    else:
        print(f"NOTE: openpyxl check skipped ({readback['reason']})")

    if args.json_out:
        # The validation directory usually does not exist yet on the first run.
        # Create it rather than dying after the workbook already passed.
        out_dir = os.path.dirname(os.path.abspath(args.json_out))
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(args.json_out, "w", encoding="utf-8") as handle:
                json.dump(summary, handle, indent=2)
        except OSError as err:
            # The workbook is fine; only the report failed to land. Say so
            # without implying the artifact is bad.
            print(f"WARN: workbook passed but the summary could not be written: {err}")
            return
        print(f"OK: summary written to {args.json_out}")


if __name__ == "__main__":
    main()
