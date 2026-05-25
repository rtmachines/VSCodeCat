from __future__ import annotations

import json
import pathlib
import sys

import pytest

from .. import project
from ..main import main as blark_main


TWINCAT_ROOT = pathlib.Path(__file__).parent / "twincat_root"
SAMPLE_SOLUTION = TWINCAT_ROOT / "SampleLibraryA" / "SampleLibraryA.sln"
PROJECT_A_SOLUTION = TWINCAT_ROOT / "project_a" / "project_a.sln"


def load_manifest(structured: pathlib.Path) -> dict:
    with open(structured / project.MANIFEST_FILENAME, "rt", encoding="utf-8") as fp:
        return json.load(fp)


def test_project_decode_encode_round_trip(tmp_path: pathlib.Path):
    structured = tmp_path / "structured"
    native_output = tmp_path / "native_output"

    manifest = project.decode(SAMPLE_SOLUTION, structured)
    assert manifest["format"] == project.MANIFEST_FORMAT
    assert len(manifest["items"]) == 2
    assert (structured / project.MANIFEST_FILENAME).is_file()
    assert (structured / project.NATIVE_DIRNAME / manifest["native_entry"]).is_file()

    project.encode(structured, native_output)

    source_item = manifest["items"][0]
    original_source = SAMPLE_SOLUTION.parent / source_item["source_path"]
    encoded_source = native_output / source_item["source_path"]
    assert encoded_source.read_bytes() == original_source.read_bytes()


def test_project_encode_applies_structured_text_change(tmp_path: pathlib.Path):
    structured = tmp_path / "structured"
    native_output = tmp_path / "native_output"

    manifest = project.decode(SAMPLE_SOLUTION, structured)
    implementation = next(
        item
        for item in manifest["items"]
        if item["identifier"].endswith("/implementation")
    )
    st_path = structured / implementation["st_path"]
    st_path.write_text("fOutput := fInput + 1.0;", encoding="utf-8")

    project.encode(structured, native_output)

    encoded_source = native_output / implementation["source_path"]
    assert "fOutput := fInput + 1.0;" in encoded_source.read_text(
        encoding="utf-8-sig"
    )


def test_project_cli_decode_via_top_level(
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
):
    structured = tmp_path / "structured"
    monkeypatch.setattr(
        sys,
        "argv",
        ["blark", "project", "decode", str(SAMPLE_SOLUTION), str(structured)],
    )

    blark_main()

    manifest = load_manifest(structured)
    assert manifest["native_entry"] == "SampleLibraryA.sln"


def test_project_decode_rejects_unsupported_compile_item(tmp_path: pathlib.Path):
    with pytest.raises(project.ProjectCommandError, match="unsupported extension"):
        project.decode(PROJECT_A_SOLUTION, tmp_path / "structured")


def test_project_decode_rejects_unsupported_input_extension(tmp_path: pathlib.Path):
    unsupported = tmp_path / "not_twincat.txt"
    unsupported.write_text("not a TwinCAT project", encoding="utf-8")

    with pytest.raises(project.ProjectCommandError, match="supported TwinCAT"):
        project.decode(unsupported, tmp_path / "structured")


def test_project_decode_rejects_existing_output_without_overwrite(
    tmp_path: pathlib.Path,
):
    structured = tmp_path / "structured"
    structured.mkdir()
    (structured / "existing.txt").write_text("already here", encoding="utf-8")

    with pytest.raises(project.ProjectCommandError, match="already exists"):
        project.decode(SAMPLE_SOLUTION, structured)


def test_project_encode_rejects_missing_manifest(tmp_path: pathlib.Path):
    structured = tmp_path / "structured"
    structured.mkdir()

    with pytest.raises(project.ProjectCommandError, match=project.MANIFEST_FILENAME):
        project.encode(structured, tmp_path / "native_output")


def test_project_encode_rejects_extra_st_file(tmp_path: pathlib.Path):
    structured = tmp_path / "structured"
    project.decode(SAMPLE_SOLUTION, structured)
    extra = structured / project.ST_DIRNAME / "extra.st"
    extra.write_text("PROGRAM Extra\nEND_PROGRAM", encoding="utf-8")

    with pytest.raises(project.ProjectCommandError, match="not declared"):
        project.encode(structured, tmp_path / "native_output")
