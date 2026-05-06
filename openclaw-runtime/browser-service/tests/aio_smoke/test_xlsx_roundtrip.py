def _cells_by_ref(worksheet):
    return {str(cell.get("ref")): cell for cell in worksheet.get("cells") or []}


def test_xlsx_roundtrip_preserves_formula_and_sheet_metadata(tmp_path, office):
    path = tmp_path / "sales-plan.xlsx"
    office.save_spreadsheet(
        str(path),
        {
            "sheets": [
                {
                    "name": "Pipeline",
                    "cells": [
                        {"ref": "A1", "value": "Account"},
                        {"ref": "B1", "value": "Stage"},
                        {"ref": "C1", "value": "Probability"},
                        {"ref": "D1", "value": "Deal Size"},
                        {"ref": "E1", "value": "Weighted Value"},
                        {"ref": "A2", "value": "Acme"},
                        {"ref": "B2", "value": "Proposal"},
                        {"ref": "C2", "value": "0.75", "kind": "number"},
                        {"ref": "D2", "value": "50000", "kind": "number"},
                        {"ref": "E2", "formula": "D2*C2", "value": "37500", "display": "37500"},
                        {"ref": "A3", "value": "Globex"},
                        {"ref": "B3", "value": "Discovery"},
                        {"ref": "C3", "value": "0.4", "kind": "number"},
                        {"ref": "D3", "value": "120000", "kind": "number"},
                        {"ref": "E3", "formula": "D3*C3", "value": "48000", "display": "48000"},
                    ],
                    "freezePane": {"ref": "A2"},
                    "filterRef": "A1:E3",
                    "columns": [{"index": 4, "width": 14}, {"index": 5, "width": 18}],
                    "rows": [{"index": 1, "height": 24}],
                }
            ]
        },
    )

    aio = office.inspect_aio(str(path))
    worksheet = aio["object"]["worksheets"][0]
    worksheet["cells"].extend(
        [
            {"ref": "A4", "row": 4, "col": 1, "value": "Initech", "value_kind": "string"},
            {"ref": "B4", "row": 4, "col": 2, "value": "Negotiation", "value_kind": "string"},
            {"ref": "C4", "row": 4, "col": 3, "value": "0.6", "value_kind": "number"},
            {"ref": "D4", "row": 4, "col": 4, "value": "85000", "value_kind": "number"},
            {"ref": "E4", "row": 4, "col": 5, "formula": "D4*C4", "value": "51000", "display": "51000"},
            {"ref": "A5", "row": 5, "col": 1, "value": "Totals", "value_kind": "string"},
            {"ref": "D5", "row": 5, "col": 4, "formula": "SUM(D2:D4)", "value": "255000", "display": "255000"},
            {"ref": "E5", "row": 5, "col": 5, "formula": "SUM(E2:E4)", "value": "136500", "display": "136500"},
        ]
    )
    worksheet["extent"] = {"rows": 5, "cols": 5}
    worksheet["freeze_pane"] = {"ref": "A2"}
    worksheet["filter_ref"] = "A1:E5"

    office.apply_aio(str(path), aio)
    reread = office.inspect_aio(str(path))
    sheet = reread["object"]["worksheets"][0]
    cells = _cells_by_ref(sheet)

    assert sheet["name"] == "Pipeline"
    assert sheet["freeze_pane"]["ref"] == "A2"
    assert sheet["filter_ref"] == "A1:E5"
    assert cells["E4"]["formula"] == "D4*C4"
    assert cells["D5"]["formula"] == "SUM(D2:D4)"
    assert cells["E5"]["formula"] == "SUM(E2:E4)"
