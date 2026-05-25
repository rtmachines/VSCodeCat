"""
``blark project`` decodes and encodes TwinCAT projects.

The structured representation created by ``decode`` keeps a byte-for-byte copy
of the native TwinCAT project tree under ``native/`` and extracts editable
Structured Text snippets under ``st/``.  ``encode`` validates the manifest and
all extracted snippets before applying changed snippets back to a copied native
tree.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import pathlib
import re
import shutil
import sys
from collections import defaultdict
from typing import Any, Iterable, Optional, Union

import lxml.etree

from . import solution, util
from .input import BlarkCompositeSourceItem, BlarkSourceItem, load_file_by_name
from .parse import parse_source_code


DESCRIPTION = __doc__

MANIFEST_FILENAME = "blark_twincat.json"
MANIFEST_FORMAT = "blark.twincat.project"
MANIFEST_VERSION = 1
NATIVE_DIRNAME = "native"
ST_DIRNAME = "st"

SUPPORTED_PROJECT_EXTENSIONS = {
    solution.Solution.file_extension.lower(),
    solution.TwincatTsProject.file_extension.lower(),
    solution.TwincatPlcProject.file_extension.lower(),
}
SUPPORTED_SOURCE_EXTENSIONS = {
    solution.TcDUT.file_extension.lower(),
    solution.TcGVL.file_extension.lower(),
    solution.TcIO.file_extension.lower(),
    solution.TcPOU.file_extension.lower(),
    solution.TcTTO.file_extension.lower(),
}
SUPPORTED_NATIVE_EXTENSIONS = SUPPORTED_PROJECT_EXTENSIONS | SUPPORTED_SOURCE_EXTENSIONS


class ProjectCommandError(RuntimeError):
    """A detailed, user-actionable ``blark project`` error."""


@dataclasses.dataclass
class NativeProjectLayout:
    """Validated native TwinCAT project layout details."""

    input_path: pathlib.Path
    source_root: pathlib.Path
    native_entry: pathlib.Path


def build_arg_parser(argparser=None):
    if argparser is None:
        argparser = argparse.ArgumentParser()

    argparser.description = DESCRIPTION
    argparser.formatter_class = argparse.RawTextHelpFormatter

    subparsers = argparser.add_subparsers(
        dest="action",
        help="Project conversion action",
    )

    decode_parser = subparsers.add_parser(
        "decode",
        help="Decode native TwinCAT artifacts into a structured folder",
    )
    decode_parser.add_argument(
        "input_path",
        type=str,
        help=(
            "Native TwinCAT input (.sln, .tsproj, .plcproj, .TcPOU, "
            ".TcGVL, .TcDUT, .TcIO, .TcTTO)"
        ),
    )
    decode_parser.add_argument(
        "output_path",
        type=str,
        help="Structured output folder to create",
    )
    decode_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace the structured output folder if it already exists",
    )

    encode_parser = subparsers.add_parser(
        "encode",
        help="Encode a structured folder back into native TwinCAT artifacts",
    )
    encode_parser.add_argument(
        "input_path",
        type=str,
        help=f"Structured folder containing {MANIFEST_FILENAME}",
    )
    encode_parser.add_argument(
        "output_path",
        type=str,
        help="Native TwinCAT output folder to create",
    )
    encode_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace the native output folder if it already exists",
    )

    return argparser


def _format_error(
    *,
    what: str,
    where: Union[str, pathlib.Path],
    why: str,
    next_step: str,
) -> ProjectCommandError:
    return ProjectCommandError(
        "\n".join(
            (
                f"What failed: {what}",
                f"File or argument: {where}",
                f"Why it failed: {why}",
                f"What to do next: {next_step}",
            )
        )
    )


def _path_for_json(path: pathlib.Path) -> str:
    return pathlib.PurePosixPath(*path.parts).as_posix()


def _path_from_json(value: str) -> pathlib.Path:
    return pathlib.Path(*pathlib.PurePosixPath(value).parts)


def _resolve_existing_path(path: Union[str, pathlib.Path], argument: str) -> pathlib.Path:
    resolved = pathlib.Path(path).expanduser().resolve()
    if not resolved.exists():
        raise _format_error(
            what="input path validation",
            where=argument,
            why=f"{resolved} does not exist.",
            next_step="Check the path spelling and restore the missing file or folder.",
        )
    return resolved


def _ensure_file(path: pathlib.Path, argument: str) -> None:
    if not path.is_file():
        raise _format_error(
            what="input path validation",
            where=argument,
            why=f"{path} is not a file.",
            next_step="Pass a TwinCAT project/source file, not a directory.",
        )


def _ensure_directory(path: pathlib.Path, argument: str) -> None:
    if not path.is_dir():
        raise _format_error(
            what="structured folder validation",
            where=argument,
            why=f"{path} is not a directory.",
            next_step="Pass the folder created by `blark project decode`.",
        )


def _relative_to(path: pathlib.Path, root: pathlib.Path) -> Optional[pathlib.Path]:
    try:
        return path.resolve().relative_to(root.resolve())
    except ValueError:
        return None


def _ensure_not_inside(path: pathlib.Path, root: pathlib.Path, argument: str) -> None:
    if _relative_to(path, root) is not None:
        raise _format_error(
            what="output path validation",
            where=argument,
            why=f"{path} is inside {root}, which would make the copy recursive.",
            next_step="Choose an output folder outside the input project/folder.",
        )
    if _relative_to(root, path) is not None:
        raise _format_error(
            what="output path validation",
            where=argument,
            why=f"{path} contains the input folder {root}.",
            next_step="Choose a dedicated output folder that does not overlap the input.",
        )


def _safe_rmtree(path: pathlib.Path, argument: str) -> None:
    resolved = path.resolve()
    home = pathlib.Path.home().resolve()
    drive_root = pathlib.Path(resolved.anchor).resolve()
    if resolved in {home, drive_root} or len(resolved.parts) < 3:
        raise _format_error(
            what="overwrite safety validation",
            where=argument,
            why=f"{resolved} is too broad to remove safely.",
            next_step="Choose a dedicated output folder and retry with --overwrite.",
        )
    shutil.rmtree(resolved)


def _prepare_output_directory(path: pathlib.Path, overwrite: bool, argument: str) -> None:
    if path.exists():
        if not path.is_dir():
            raise _format_error(
                what="output path validation",
                where=argument,
                why=f"{path} already exists and is not a directory.",
                next_step="Choose a new folder or remove the existing file.",
            )
        if any(path.iterdir()):
            if not overwrite:
                raise _format_error(
                    what="overwrite validation",
                    where=argument,
                    why=f"{path} already exists and is not empty.",
                    next_step="Choose an empty folder or pass --overwrite to replace it.",
                )
            _safe_rmtree(path, argument)
    path.mkdir(parents=True, exist_ok=True)


def _prepare_copytree_destination(
    path: pathlib.Path,
    overwrite: bool,
    argument: str,
) -> None:
    if path.exists():
        if not path.is_dir():
            raise _format_error(
                what="output path validation",
                where=argument,
                why=f"{path} already exists and is not a directory.",
                next_step="Choose a new folder or remove the existing file.",
            )
        if any(path.iterdir()):
            if not overwrite:
                raise _format_error(
                    what="overwrite validation",
                    where=argument,
                    why=f"{path} already exists and is not empty.",
                    next_step="Choose an empty folder or pass --overwrite to replace it.",
                )
            _safe_rmtree(path, argument)
        else:
            path.rmdir()
    path.parent.mkdir(parents=True, exist_ok=True)


def _common_parent(paths: Iterable[pathlib.Path]) -> pathlib.Path:
    parents = [path.resolve().parent for path in paths]
    if not parents:
        raise _format_error(
            what="project layout validation",
            where="<native input>",
            why="No native TwinCAT files were found to copy.",
            next_step="Pass a supported TwinCAT project or source file.",
        )
    return pathlib.Path(os.path.commonpath([str(path) for path in parents])).resolve()


def _validate_source_xml(path: pathlib.Path) -> None:
    try:
        solution.TcSource.from_filename(path)
    except solution.UnsupportedSourceFileError as ex:
        raise _format_error(
            what="TwinCAT source validation",
            where=path,
            why=(
                f"The XML type is unsupported by blark project round-tripping "
                f"({ex})."
            ),
            next_step=(
                "Convert this item to a supported source type "
                "(.TcPOU, .TcGVL, .TcDUT, .TcIO, .TcTTO) or add support in blark."
            ),
        ) from ex
    except lxml.etree.XMLSyntaxError as ex:
        raise _format_error(
            what="TwinCAT source XML validation",
            where=path,
            why=f"The file is not well-formed XML ({ex}).",
            next_step="Open the file in TwinCAT or an XML editor, fix the XML, and retry.",
        ) from ex


def _validate_plc_project(plc: solution.TwincatPlcProject) -> set[pathlib.Path]:
    if plc.plcproj_path is None:
        raise _format_error(
            what="PLC project validation",
            where="<plcproj>",
            why="The PLC project XML does not have an associated file path.",
            next_step="Load the project from a real .plcproj/.tsproj/.sln file.",
        )

    plcproj_path = plc.plcproj_path.resolve()
    if not plcproj_path.exists():
        raise _format_error(
            what="PLC project validation",
            where=plcproj_path,
            why="The .plcproj file referenced by the TwinCAT project is missing.",
            next_step="Restore the .plcproj file or fix the project reference.",
        )

    native_paths = {plcproj_path}
    try:
        plcproj_xml = solution.parse_xml_file(plcproj_path)
    except (OSError, lxml.etree.XMLSyntaxError) as ex:
        raise _format_error(
            what="PLC project XML validation",
            where=plcproj_path,
            why=f"The .plcproj could not be parsed ({type(ex).__name__}: {ex}).",
            next_step="Fix the .plcproj XML and retry.",
        ) from ex

    namespaces = {"msbuild": plcproj_xml.xpath("namespace-uri()")}
    compile_items = plcproj_xml.xpath(
        "/msbuild:Project/msbuild:ItemGroup/msbuild:Compile",
        namespaces=namespaces,
    )
    for compile_item in compile_items:
        include = compile_item.attrib.get("Include")
        if not include:
            raise _format_error(
                what="PLC project compile item validation",
                where=plcproj_path,
                why=(
                    f"A <Compile> item on line {compile_item.sourceline} does "
                    "not define an Include path."
                ),
                next_step="Add the missing Include path or remove the malformed item.",
            )

        saved_path = pathlib.PureWindowsPath(include)
        try:
            local_path = util.fix_case_insensitive_path(plcproj_path.parent / saved_path)
        except FileNotFoundError as ex:
            raise _format_error(
                what="PLC project compile item validation",
                where=plcproj_path,
                why=f"The compiled source {include!r} does not exist on disk.",
                next_step="Restore the missing source file or remove it from the .plcproj.",
            ) from ex

        suffix = local_path.suffix.lower()
        if suffix not in SUPPORTED_SOURCE_EXTENSIONS:
            supported = ", ".join(sorted(SUPPORTED_SOURCE_EXTENSIONS))
            raise _format_error(
                what="PLC project compile item validation",
                where=local_path,
                why=(
                    f"The Compile item has unsupported extension {local_path.suffix!r}. "
                    f"Supported Compile extensions are: {supported}."
                ),
                next_step=(
                    "Remove unsupported Compile items, convert them to supported "
                    "TwinCAT source types, or add explicit support in blark."
                ),
            )

        _validate_source_xml(local_path)
        native_paths.add(local_path.resolve())

    return native_paths


def _validate_project_file(path: pathlib.Path) -> set[pathlib.Path]:
    native_paths = {path.resolve()}
    try:
        twincat_solution = solution.make_solution_from_files(path)
    except Exception as ex:
        raise _format_error(
            what="TwinCAT project loading",
            where=path,
            why=f"blark could not load the project ({type(ex).__name__}: {ex}).",
            next_step="Verify the TwinCAT project layout and fix missing references.",
        ) from ex

    if not twincat_solution.projects:
        raise _format_error(
            what="TwinCAT solution validation",
            where=path,
            why="No projects were found in the solution.",
            next_step="Pass a TwinCAT .sln/.tsproj/.plcproj that contains a PLC project.",
        )

    for project in twincat_solution.projects:
        if project.local_path is None:
            raise _format_error(
                what="TwinCAT solution validation",
                where=path,
                why=f"The solution references {project.saved_path}, but it is missing.",
                next_step="Restore the missing project file or fix the .sln reference.",
            )

        project_path = project.local_path.resolve()
        native_paths.add(project_path)
        if project_path.suffix.lower() not in {
            solution.TwincatTsProject.file_extension.lower(),
            solution.TwincatPlcProject.file_extension.lower(),
        }:
            raise _format_error(
                what="TwinCAT solution validation",
                where=project_path,
                why=(
                    f"The solution project has unsupported extension "
                    f"{project_path.suffix!r}."
                ),
                next_step="Pass a solution that references TwinCAT .tsproj projects only.",
            )

        try:
            loaded_project = project.load()
        except Exception as ex:
            raise _format_error(
                what="TwinCAT project loading",
                where=project_path,
                why=f"The project could not be loaded ({type(ex).__name__}: {ex}).",
                next_step="Fix missing XTI/.plcproj references and retry.",
            ) from ex

        if not loaded_project.plcs:
            raise _format_error(
                what="TwinCAT project validation",
                where=project_path,
                why="No PLC projects were found in the TwinCAT project.",
                next_step="Pass a TwinCAT project that contains at least one PLC project.",
            )

        for plc in loaded_project.plcs:
            native_paths.update(_validate_plc_project(plc))

    return native_paths


def _validate_native_input(input_path: Union[str, pathlib.Path]) -> NativeProjectLayout:
    path = _resolve_existing_path(input_path, "input_path")
    _ensure_file(path, "input_path")

    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_NATIVE_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_NATIVE_EXTENSIONS))
        raise _format_error(
            what="input extension validation",
            where=path,
            why=f"{path.suffix!r} is not a supported TwinCAT project/source extension.",
            next_step=f"Use one of these extensions: {supported}.",
        )

    if suffix in SUPPORTED_PROJECT_EXTENSIONS:
        native_paths = _validate_project_file(path)
    else:
        _validate_source_xml(path)
        native_paths = {path.resolve()}

    source_root = _common_parent(native_paths)
    native_entry = path.resolve().relative_to(source_root)
    return NativeProjectLayout(
        input_path=path,
        source_root=source_root,
        native_entry=native_entry,
    )


def _flatten_items(
    item: Union[BlarkSourceItem, BlarkCompositeSourceItem],
) -> Iterable[BlarkSourceItem]:
    if isinstance(item, BlarkCompositeSourceItem):
        for part in item.parts:
            yield from _flatten_items(part)
    else:
        yield item


def _sanitize_identifier(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", value)
    value = value.strip("._")
    return value or "source"


def _validate_st_syntax(st_path: pathlib.Path, item: BlarkSourceItem, code: str) -> None:
    result = parse_source_code(
        code,
        fn=st_path,
        starting_rule=item.grammar_rule,
        item=item,
    )
    if result.exception is not None:
        raise _format_error(
            what="Structured Text validation",
            where=st_path,
            why=(
                f"{item.identifier!r} does not parse as {item.grammar_rule!r} "
                f"({type(result.exception).__name__}: {result.exception})."
            ),
            next_step="Fix the extracted .st file so blark can parse it, then retry.",
        )


def _load_manifest(structured_dir: pathlib.Path) -> dict[str, Any]:
    manifest_path = structured_dir / MANIFEST_FILENAME
    if not manifest_path.exists():
        raise _format_error(
            what="structured manifest validation",
            where=manifest_path,
            why=f"{MANIFEST_FILENAME} is missing.",
            next_step="Run `blark project decode` first or restore the manifest file.",
        )
    if not manifest_path.is_file():
        raise _format_error(
            what="structured manifest validation",
            where=manifest_path,
            why="The manifest path exists but is not a file.",
            next_step="Replace it with the JSON manifest created by decode.",
        )

    try:
        with open(manifest_path, "rt", encoding="utf-8") as fp:
            manifest = json.load(fp)
    except json.JSONDecodeError as ex:
        raise _format_error(
            what="structured manifest validation",
            where=manifest_path,
            why=f"The manifest is not valid JSON ({ex}).",
            next_step="Fix the JSON syntax or regenerate the structured folder.",
        ) from ex

    if manifest.get("format") != MANIFEST_FORMAT:
        raise _format_error(
            what="structured manifest validation",
            where=manifest_path,
            why=f"Unexpected manifest format {manifest.get('format')!r}.",
            next_step=f"Use a manifest with format {MANIFEST_FORMAT!r}.",
        )
    if manifest.get("version") != MANIFEST_VERSION:
        raise _format_error(
            what="structured manifest validation",
            where=manifest_path,
            why=f"Unsupported manifest version {manifest.get('version')!r}.",
            next_step="Regenerate the structured folder with this version of blark.",
        )
    if not isinstance(manifest.get("items"), list):
        raise _format_error(
            what="structured manifest validation",
            where=manifest_path,
            why="The manifest does not contain an items list.",
            next_step="Regenerate the structured folder with `blark project decode`.",
        )
    return manifest


def _validate_manifest_paths(
    structured_dir: pathlib.Path,
    manifest: dict[str, Any],
) -> tuple[pathlib.Path, pathlib.Path]:
    native_root = structured_dir / manifest.get("native_root", NATIVE_DIRNAME)
    st_root = structured_dir / manifest.get("st_root", ST_DIRNAME)
    if not native_root.is_dir():
        raise _format_error(
            what="structured native folder validation",
            where=native_root,
            why="The native project copy folder is missing.",
            next_step="Restore the native/ folder or rerun decode.",
        )
    if not st_root.is_dir():
        raise _format_error(
            what="structured ST folder validation",
            where=st_root,
            why="The extracted Structured Text folder is missing.",
            next_step="Restore the st/ folder or rerun decode.",
        )

    declared_st_paths = set()
    for index, item in enumerate(manifest["items"], start=1):
        if not isinstance(item, dict):
            raise _format_error(
                what="structured manifest item validation",
                where=f"{MANIFEST_FILENAME}:items[{index}]",
                why="The item is not a JSON object.",
                next_step="Regenerate the structured folder or fix the manifest item.",
            )

        st_path_value = item.get("st_path")
        source_path_value = item.get("source_path")
        identifier = item.get("identifier")
        if not st_path_value or not source_path_value or not identifier:
            raise _format_error(
                what="structured manifest item validation",
                where=f"{MANIFEST_FILENAME}:items[{index}]",
                why="The item must include st_path, source_path, and identifier.",
                next_step="Regenerate the structured folder or fix the manifest item.",
            )

        st_path = structured_dir / _path_from_json(st_path_value)
        source_path = native_root / _path_from_json(source_path_value)
        if _relative_to(st_path, st_root) is None:
            raise _format_error(
                what="structured manifest item validation",
                where=st_path,
                why="The manifest points to a .st file outside the st/ folder.",
                next_step="Move the file under st/ or regenerate the structured folder.",
            )
        if _relative_to(source_path, native_root) is None:
            raise _format_error(
                what="structured manifest item validation",
                where=source_path,
                why="The manifest points to a native source outside native/.",
                next_step="Fix the source_path or regenerate the structured folder.",
            )
        if st_path.suffix.lower() != ".st":
            raise _format_error(
                what="structured manifest item validation",
                where=st_path,
                why="Extracted source files must use the .st extension.",
                next_step="Rename the file to .st and update the manifest.",
            )
        if not st_path.is_file():
            raise _format_error(
                what="structured ST validation",
                where=st_path,
                why="The manifest references a missing .st file.",
                next_step="Restore the missing file or remove the manifest item.",
            )
        if not source_path.is_file():
            raise _format_error(
                what="structured native validation",
                where=source_path,
                why="The manifest references a missing native TwinCAT source file.",
                next_step="Restore the missing file under native/ or rerun decode.",
            )
        if source_path.suffix.lower() not in SUPPORTED_SOURCE_EXTENSIONS:
            raise _format_error(
                what="structured native validation",
                where=source_path,
                why=f"Unsupported native source extension {source_path.suffix!r}.",
                next_step="Regenerate the structured folder with supported TwinCAT files.",
            )
        declared_st_paths.add(st_path.resolve())

    actual_st_paths = {
        path.resolve()
        for path in st_root.rglob("*")
        if path.is_file()
        and path.suffix.lower() == ".st"
    }
    extra_st_paths = sorted(actual_st_paths - declared_st_paths)
    if extra_st_paths:
        extra = extra_st_paths[0]
        raise _format_error(
            what="structured ST validation",
            where=extra,
            why="A .st file exists under st/ but is not declared in the manifest.",
            next_step=(
                "Remove the extra file or regenerate the structured folder so every "
                ".st file has round-trip metadata."
            ),
        )

    return native_root, st_root


def decode(
    input_path: Union[str, pathlib.Path],
    output_path: Union[str, pathlib.Path],
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    layout = _validate_native_input(input_path)
    output_dir = pathlib.Path(output_path).expanduser().resolve()
    _ensure_not_inside(output_dir, layout.source_root, "output_path")

    manifest_items: list[dict[str, Any]] = []
    extracted_blocks: list[tuple[pathlib.Path, str]] = []
    loaded_items = load_file_by_name(layout.input_path)
    source_index = 0
    for loaded_item in loaded_items:
        for item in _flatten_items(loaded_item):
            source_index += 1
            filenames = sorted(item.get_filenames(), key=str)
            if len(filenames) != 1:
                raise _format_error(
                    what="source item validation",
                    where=layout.input_path,
                    why=(
                        f"{item.identifier!r} maps to {len(filenames)} files; "
                        "exactly one source file is required for round-tripping."
                    ),
                    next_step="Split the item into file-local parts and retry.",
                )

            source_filename = pathlib.Path(filenames[0]).resolve()
            source_rel = _relative_to(source_filename, layout.source_root)
            if source_rel is None:
                raise _format_error(
                    what="source root validation",
                    where=source_filename,
                    why=f"The source file is outside {layout.source_root}.",
                    next_step=(
                        "Move all TwinCAT project files under one project root before "
                        "decoding."
                    ),
                )

            code, _ = item.get_code_and_line_map()
            st_rel = (
                pathlib.Path(ST_DIRNAME)
                / source_rel
                / f"{source_index:04d}_{_sanitize_identifier(item.identifier)}.st"
            )
            _validate_st_syntax(output_dir / st_rel, item, code)
            extracted_blocks.append((st_rel, code))

            manifest_items.append(
                {
                    "identifier": item.identifier,
                    "type": item.type.name,
                    "grammar_rule": item.grammar_rule,
                    "implicit_end": item.implicit_end,
                    "source_path": _path_for_json(source_rel),
                    "st_path": _path_for_json(st_rel),
                }
            )

    _prepare_output_directory(output_dir, overwrite, "output_path")
    native_root = output_dir / NATIVE_DIRNAME
    st_root = output_dir / ST_DIRNAME
    if native_root.exists() or st_root.exists():
        raise _format_error(
            what="structured output validation",
            where=output_dir,
            why="The output folder already contains native/ or st/.",
            next_step="Choose a fresh folder or pass --overwrite.",
        )

    shutil.copytree(layout.source_root, native_root)
    st_root.mkdir()
    for st_rel, code in extracted_blocks:
        st_path = output_dir / st_rel
        st_path.parent.mkdir(parents=True, exist_ok=True)
        st_path.write_text(code, encoding="utf-8")

    manifest = {
        "format": MANIFEST_FORMAT,
        "version": MANIFEST_VERSION,
        "native_root": NATIVE_DIRNAME,
        "st_root": ST_DIRNAME,
        "native_entry": _path_for_json(layout.native_entry),
        "input_path": str(layout.input_path),
        "items": manifest_items,
    }
    manifest_path = output_dir / MANIFEST_FILENAME
    with open(manifest_path, "wt", encoding="utf-8") as fp:
        json.dump(manifest, fp, indent=2)
        fp.write("\n")

    print(
        f"Decoded {layout.input_path} to {output_dir} "
        f"({len(manifest_items)} Structured Text blocks)."
    )
    return manifest


def _source_items_by_identifier(
    source: solution.TcSource,
) -> dict[str, BlarkSourceItem]:
    result = {}
    for loaded_item in source.to_blark():
        for item in _flatten_items(loaded_item):
            result[item.identifier] = item
    return result


def encode(
    input_path: Union[str, pathlib.Path],
    output_path: Union[str, pathlib.Path],
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    structured_dir = _resolve_existing_path(input_path, "input_path")
    _ensure_directory(structured_dir, "input_path")
    output_dir = pathlib.Path(output_path).expanduser().resolve()
    _ensure_not_inside(output_dir, structured_dir, "output_path")

    manifest = _load_manifest(structured_dir)
    native_root, _ = _validate_manifest_paths(structured_dir, manifest)

    items_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in manifest["items"]:
        items_by_source[item["source_path"]].append(item)

    changes_by_source: dict[str, list[tuple[str, str, pathlib.Path]]] = defaultdict(list)
    changed_blocks = 0
    for source_path_value, manifest_items in sorted(items_by_source.items()):
        source_rel = _path_from_json(source_path_value)
        native_source_path = native_root / source_rel
        try:
            source = solution.TcSource.from_filename(native_source_path)
        except Exception as ex:
            raise _format_error(
                what="native source loading",
                where=native_source_path,
                why=f"The copied native source could not be loaded ({type(ex).__name__}: {ex}).",
                next_step="Restore the native source file or regenerate the structured folder.",
            ) from ex

        source_items = _source_items_by_identifier(source)
        for manifest_item in manifest_items:
            identifier = manifest_item["identifier"]
            try:
                source_item = source_items[identifier]
            except KeyError:
                raise _format_error(
                    what="structured manifest item validation",
                    where=native_source_path,
                    why=f"The identifier {identifier!r} no longer exists in the source file.",
                    next_step=(
                        "Restore the original native source structure or regenerate the "
                        "structured folder."
                    ),
                ) from None

            st_path = structured_dir / _path_from_json(manifest_item["st_path"])
            st_code = st_path.read_text(encoding="utf-8")
            _validate_st_syntax(st_path, source_item, st_code)
            current_code, _ = source_item.get_code_and_line_map()
            if st_code == current_code:
                continue

            changes_by_source[source_path_value].append((identifier, st_code, st_path))
            changed_blocks += 1

    _prepare_copytree_destination(output_dir, overwrite, "output_path")
    shutil.copytree(native_root, output_dir)

    changed_files = 0
    for source_path_value, changes in sorted(changes_by_source.items()):
        source_rel = _path_from_json(source_path_value)
        output_source_path = output_dir / source_rel
        try:
            source = solution.TcSource.from_filename(output_source_path)
        except Exception as ex:
            raise _format_error(
                what="native source loading",
                where=output_source_path,
                why=f"The copied native source could not be loaded ({type(ex).__name__}: {ex}).",
                next_step="Restore the native source file or regenerate the structured folder.",
            ) from ex

        for identifier, st_code, st_path in changes:
            try:
                source.rewrite_code(identifier, st_code)
            except Exception as ex:
                raise _format_error(
                    what="native source rewrite",
                    where=output_source_path,
                    why=(
                        f"Could not apply {st_path} to {identifier!r} "
                        f"({type(ex).__name__}: {ex})."
                    ),
                    next_step="Check that the manifest identifier still matches the native file.",
                ) from ex

        output_source_path.write_bytes(source.to_file_contents())
        changed_files += 1

    print(
        f"Encoded {structured_dir} to {output_dir} "
        f"({changed_blocks} changed blocks in {changed_files} files)."
    )
    return manifest


def main(
    action: Optional[str] = None,
    input_path: Optional[str] = None,
    output_path: Optional[str] = None,
    overwrite: bool = False,
):
    try:
        if action == "decode":
            if input_path is None or output_path is None:
                raise _format_error(
                    what="CLI argument validation",
                    where="decode",
                    why="decode requires input_path and output_path.",
                    next_step="Run `blark project decode --help` for usage.",
                )
            return decode(input_path, output_path, overwrite=overwrite)
        if action == "encode":
            if input_path is None or output_path is None:
                raise _format_error(
                    what="CLI argument validation",
                    where="encode",
                    why="encode requires input_path and output_path.",
                    next_step="Run `blark project encode --help` for usage.",
                )
            return encode(input_path, output_path, overwrite=overwrite)

        raise _format_error(
            what="CLI argument validation",
            where="project",
            why=f"Unknown or missing action {action!r}.",
            next_step="Choose either `decode` or `encode`; run `blark project --help`.",
        )
    except ProjectCommandError as ex:
        print(f"blark project {action or ''} failed:\n{ex}", file=sys.stderr)
        raise SystemExit(2) from ex
