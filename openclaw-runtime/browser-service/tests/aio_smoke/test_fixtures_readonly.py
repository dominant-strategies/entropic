from pathlib import Path


FIXTURES = Path(__file__).resolve().parent / "fixtures"


def test_seed_xlsx_fixture_inspects_expected_structure(office):
    aio = office.inspect_aio(str(FIXTURES / "seed-pipeline.xlsx"))
    workbook = aio["object"]
    sheet = workbook["worksheets"][0]
    cells = {cell["ref"]: cell for cell in sheet["cells"]}

    assert aio["kind"] == "spreadsheet"
    assert sheet["name"] == "Pipeline"
    assert sheet["freeze_pane"]["ref"] == "A2"
    assert sheet["filter_ref"] == "A1:E5"
    assert cells["E2"]["formula"] == "C2*D2"
    assert cells["E5"]["formula"] == "SUM(E2:E4)"


def test_seed_docx_fixture_inspects_expected_blocks(office):
    aio = office.inspect_aio(str(FIXTURES / "seed-project-plan.docx"))
    blocks = aio["object"]["blocks"]

    assert aio["kind"] == "document"
    assert any(block.get("kind") == "heading" and block.get("text") == "Project Plan" for block in blocks)
    assert any(block.get("style_ref") == "List Bullet" for block in blocks)
    assert any(block.get("kind") == "table" for block in blocks)


def test_seed_pptx_fixture_inspects_expected_slide_objects(office):
    aio = office.inspect_aio(str(FIXTURES / "seed-pipeline-review.pptx"))
    slides = aio["object"]["slides"]
    first_slide = slides[0]

    assert aio["kind"] == "presentation"
    assert first_slide["title"] == "Pipeline Review"
    assert first_slide["body"]["items"][1]["text"] == "Next steps"
    assert "weekly pipeline meeting" in first_slide["notes"][0]
    assert any(obj.get("text") == "Target close: Q2" for obj in first_slide.get("objects") or [])
