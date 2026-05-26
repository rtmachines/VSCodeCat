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
LCLS_GENERAL_SOLUTION = (
    TWINCAT_ROOT / "lcls-twincat-general" / "v2.8.1" / "LCLSGeneral.sln"
)


def load_manifest(structured: pathlib.Path) -> dict:
    manifest_path = (
        structured
        / project.METADATA_DIRNAME
        / project.MANIFEST_FILENAME
    )
    with open(manifest_path, "rt", encoding="utf-8") as fp:
        return json.load(fp)


def test_project_decode_encode_round_trip(tmp_path: pathlib.Path):
    structured = tmp_path / "structured"
    native_output = tmp_path / "native_output"

    manifest = project.decode(SAMPLE_SOLUTION, structured)
    assert manifest["format"] == project.MANIFEST_FORMAT
    assert manifest["version"] == project.MANIFEST_VERSION
    assert len(manifest["items"]) == 2
    assert (
        structured / project.METADATA_DIRNAME / project.MANIFEST_FILENAME
    ).is_file()
    assert (structured / project.METADATA_DIRNAME / project.INDEX_FILENAME).is_file()
    assert (structured / project.ROOT_CONFIG_FILENAME).is_file()
    assert (structured / project.NATIVE_DIRNAME / manifest["native_entry"]).is_file()

    project.encode(structured, native_output)

    source_item = manifest["items"][0]
    original_source = SAMPLE_SOLUTION.parent / source_item["source_path"]
    encoded_source = native_output / source_item["source_path"]
    assert encoded_source.read_bytes() == original_source.read_bytes()


def test_project_decode_preserves_twincat_object_layout(tmp_path: pathlib.Path):
    structured = tmp_path / "structured"

    manifest = project.decode(SAMPLE_SOLUTION, structured)

    expected_declaration = (
        structured
        / project.SOURCE_DIRNAME
        / "SampleLibraryA"
        / "SampleLibraryA"
        / "POUs"
        / "FB_SampleA_Test"
        / "declaration.st"
    )
    expected_implementation = expected_declaration.with_name("implementation.st")
    assert expected_declaration.is_file()
    assert expected_implementation.is_file()
    assert not (
        structured
        / project.SOURCE_DIRNAME
        / "SampleLibraryA"
        / "SampleLibraryA"
        / "POUs"
        / "FB_SampleA_Test.st"
    ).exists()
    assert {
        item["path"]
        for item in manifest["items"]
        if item["object_identifier"] == "FB_SampleA_Test"
    } == {
        "src/SampleLibraryA/SampleLibraryA/POUs/FB_SampleA_Test/declaration.st",
        "src/SampleLibraryA/SampleLibraryA/POUs/FB_SampleA_Test/implementation.st",
    }

    declaration_code = expected_declaration.read_text(encoding="utf-8")
    implementation_code = expected_implementation.read_text(encoding="utf-8")
    assert "FUNCTION_BLOCK FB_SampleA_Test" in declaration_code
    assert "END_FUNCTION_BLOCK" in declaration_code
    assert "fOutput := fInput;" in implementation_code


def test_project_decode_preserves_nested_twincat_object_layout(
    tmp_path: pathlib.Path,
):
    structured = tmp_path / "structured"

    manifest = project.decode(LCLS_GENERAL_SOLUTION, structured)

    fb_declaration = (
        structured
        / project.SOURCE_DIRNAME
        / "LCLSGeneral"
        / "LCLSGeneral"
        / "POUs"
        / "Logger"
        / "FB_LogHandler"
        / "declaration.st"
    )
    action_st = fb_declaration.parent / "actions" / "CircuitBreaker.st"
    assert fb_declaration.is_file()
    assert action_st.is_file()
    assert not (
        structured
        / project.SOURCE_DIRNAME
        / "LCLSGeneral"
        / "LCLSGeneral"
        / "POUs"
        / "Logger"
        / "FB_LogHandler.st"
    ).exists()
    fb_code = fb_declaration.read_text(encoding="utf-8")
    action_code = action_st.read_text(encoding="utf-8")
    assert "FUNCTION_BLOCK FB_LogHandler" in fb_code
    assert "// Global log circuit breaker" in action_code
    assert {
        item["path"]
        for item in manifest["items"]
        if item["object_identifier"] == "FB_LogHandler"
    } >= {
        "src/LCLSGeneral/LCLSGeneral/POUs/Logger/FB_LogHandler/declaration.st",
        "src/LCLSGeneral/LCLSGeneral/POUs/Logger/FB_LogHandler/actions/CircuitBreaker.st",
    }

    interface_declaration = (
        structured
        / project.SOURCE_DIRNAME
        / "LCLSGeneral"
        / "LCLSGeneral"
        / "Interfaces"
        / "I_Interface"
        / "declaration.st"
    )
    method_declaration = interface_declaration.parent / "methods" / "Method1" / "declaration.st"
    property_declaration = (
        interface_declaration.parent
        / "properties"
        / "Property1"
        / "get"
        / "declaration.st"
    )
    assert interface_declaration.is_file()
    assert method_declaration.is_file()
    assert property_declaration.is_file()
    interface_code = interface_declaration.read_text(encoding="utf-8")
    method_code = method_declaration.read_text(encoding="utf-8")
    property_code = property_declaration.read_text(encoding="utf-8")
    assert "INTERFACE I_Interface" in interface_code
    assert "METHOD Method1 : BOOL" in method_code
    assert "PROPERTY Property1 : INT" in property_code


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
    st_code = st_path.read_text(encoding="utf-8")
    st_path.write_text(
        st_code.replace("fOutput := fInput;", "fOutput := fInput + 1.0;"),
        encoding="utf-8",
    )

    project.encode(structured, native_output)

    encoded_source = native_output / implementation["source_path"]
    assert "fOutput := fInput + 1.0;" in encoded_source.read_text(
        encoding="utf-8-sig"
    )


def test_project_encode_applies_nested_member_change_from_split_st(
    tmp_path: pathlib.Path,
):
    structured = tmp_path / "structured"
    native_output = tmp_path / "native_output"

    manifest = project.decode(LCLS_GENERAL_SOLUTION, structured)
    action = next(
        item
        for item in manifest["items"]
        if item["identifier"] == "FB_LogHandler.CircuitBreaker"
    )
    declaration = next(
        item
        for item in manifest["items"]
        if item["identifier"] == "FB_LogHandler/declaration"
    )
    declaration_path = structured / declaration["path"]
    action_path = structured / action["path"]
    declaration_code = declaration_path.read_text(encoding="utf-8")
    action_code = action_path.read_text(encoding="utf-8")
    declaration_path.write_text(
        declaration_code.replace(
            "FUNCTION_BLOCK FB_LogHandler",
            "FUNCTION_BLOCK FB_LogHandler\n// inserted declaration comment",
        ),
        encoding="utf-8",
    )
    action_path.write_text(
        action_code.replace(
            "GVL_Logger.nGlobAccEvents := 0;",
            "GVL_Logger.nGlobAccEvents := 1;",
        ),
        encoding="utf-8",
    )

    project.encode(structured, native_output)

    encoded_source = native_output / action["source_path"]
    encoded_code = encoded_source.read_text(encoding="utf-8-sig")
    assert "// inserted declaration comment" in encoded_code
    assert "GVL_Logger.nGlobAccEvents := 1;" in encoded_code


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
    extra = structured / project.SOURCE_DIRNAME / "extra.st"
    extra.write_text("PROGRAM Extra\nEND_PROGRAM", encoding="utf-8")

    with pytest.raises(project.ProjectCommandError, match="not declared"):
        project.encode(structured, tmp_path / "native_output")
