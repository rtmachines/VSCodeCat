# Beckhoff TwinCAT IEC 61131-3 Lark-based Structured Text Tools

Or for short, blark.  B(eckhoff)-lark. It sounded good in my head, at least.

## The Grammar

The [grammar](blark/iec.lark) uses Lark's Earley parser algorithm.

The grammar itself is not perfect.  It may not reliably parse your source code
or produce useful Python instances just yet.

See [issues](https://github.com/klauer/blark/issues) for further details.

As a fun side project, blark isn't at the top of my priority list.  For
an idea of where the project is going, see the issues list.

## Requirements

* [lark](https://github.com/lark-parser/lark) (for grammar-based parsing)
* [lxml](https://github.com/lxml/lxml) (for parsing TwinCAT projects)

## Capabilities

* TwinCAT source code file parsing (``*.TcPOU`` and others)
* TwinCAT project and solution loading
* ``lark.Tree`` generation of any supported source code
* Python dataclasses of supported source code, with introspection and code refactoring

## VSCodeCat VS Code extension

This repository also contains the VSCodeCat extension MVP for editing TwinCAT
projects in VS Code while round-tripping through the existing ``blark`` backend.

The extension contributes:

* TwinCAT Structured Text language support for ``.st`` files.
* Commands to decode native TwinCAT projects, validate decoded workspaces,
  preview native output diffs, and encode back to a separate output folder.
* PLC object, mapping, diagnostics, and native output diff tree views.
* Safe staged creation for new POUs, interfaces, DUTs, and GVLs.

Developer setup:

```bash
npm install
npm run compile
```

Then open this folder in VS Code and use the "Run Extension" launch target or
run commands from the Command Palette under "VSCodeCat". By default the
extension auto-detects ``dist/blark.exe``, ``blark``, or ``python -m blark``;
override this with the ``vscodecat.blark.command`` setting when needed.

### Works-in-progress

* Sphinx API documentation generation (a new Sphinx domain)
* Code reformatting
* "Dependency store" - recursively parse and inspect project dependencies
* Summary generation - a layer on top of dataclasses to summarize source code details
* Rewriting source code directly in TwinCAT source code files

## Installation

Installation is quick with Pip.

```bash
pip install --upgrade blark
```

### Quickstart (pip / virtualenv with venv)

1. Set up an environment using venv:
  ```bash
  $ python -m venv blark_venv
  $ source blark_venv/bin/activate
  ```
2. Install the library with pip:
  ```bash
  $ python -m pip install blark
  ```

### Quickstart (Conda)

1. Set up an environment using conda:
  ```bash
  $ conda create -n blark-env -c conda-forge python=3.10 pip blark
  $ conda activate blark-env
  ```
2. Install the library from conda:
  ```bash
  $ conda install blark
  ```

### Development install

If you run into issues or wish to run an unreleased version of blark, you may
install directly from this repository like so:
```bash
$ python -m pip install git+https://github.com/klauer/blark
```

### Build a single-file Windows executable

To build `blark.exe` as a single-file CLI on Windows:

```bash
$ python -m pip install -r requirements-dev.txt
$ python -m PyInstaller --clean --noconfirm blark.spec
```

The generated executable will be written to `dist/blark.exe`.

## CLI application

You can run the CLI in any of these forms:

```bash
$ blark --help
$ python -m blark --help
dist/blark.exe --help
```

The top-level application exposes three subcommands:

| Command | Purpose | Typical input | Default output |
| --- | --- | --- | --- |
| `blark parse` | Parse TwinCAT or plain Structured Text source and inspect the parse results | `.sln`, `.tsproj`, `.plcproj`, `.TcPOU`, `.TcGVL`, `.TcDUT`, `.TcIO`, `.TcTTO`, `.st` | Console output, JSON, or summaries |
| `blark format` | Reformat parsed source code and optionally write it back out | Same as `parse` | Reformatted code to stdout unless `--overwrite` or `--write-to` is used |
| `blark project` | Decode and encode TwinCAT projects to and from a structured round-trip folder | Native TwinCAT artifacts or a previously decoded folder | A structured folder (`decode`) or native TwinCAT tree (`encode`) |

The quickest way to discover command-specific flags is through `--help`:

```bash
$ blark parse --help
$ blark format --help
$ blark project --help
$ blark project decode --help
$ blark project encode --help
```

### `blark parse`

Use `parse` when you want to inspect source code without modifying it.

- It can parse a single file, a PLC project, or a full TwinCAT solution.
- By default it prints parse failures and exits with code `1` if any source block fails to parse.
- `--debug` keeps the process running even when failures are encountered, which is useful when exploring mixed or partially supported projects.
- `--json` emits the transformed representation instead of the tree or summary.
- `--summary` builds a higher-level outline of declarations, implementations, and relationships.
- `--filter` narrows parsing to matching identifiers or filenames.
- `--interactive` opens an IPython or Python debugging session with the parse results loaded.

Safe examples:

```bash
$ blark parse --print-tree blark/tests/POUs/F_SetStateParams.TcPOU
$ blark parse --summary blark/tests/twincat_root/SampleLibraryA/SampleLibraryA.sln
$ blark parse --json blark/tests/source/array_of_objects.st
```

### `blark format`

Use `format` when you want consistent source formatting or want to rewrite TwinCAT XML-backed source files with reformatted Structured Text.

- Without `--overwrite` or `--write-to`, formatted output is written to stdout.
- `--overwrite` writes back to the original source path.
- `--write-to` writes to a separate file or directory.
- `--input-format` forces the input loader when the extension is ambiguous.
- `--output-format` selects a specific writer when you do not want the input format preserved.
- `--indent` changes the indentation string used for formatted output.

Safe examples:

```bash
$ blark format blark/tests/source/array_of_objects.st
$ blark format --debug blark/tests/POUs/F_SetStateParams.TcPOU
```

Typical write workflows:

```bash
blark format --overwrite path/to/file.TcPOU
blark format --write-to out/ path/to/project.sln
blark format --output-format html --write-to report.html path/to/file.st
```

### `blark project`

Use `project` when you want a round-trip friendly representation of TwinCAT projects.

`blark project decode`:

- Validates the input path, extension, TwinCAT layout, and supported file types.
- Copies the native project tree into `native/`.
- Extracts editable Structured Text into `st/`, using one `.st` file per TwinCAT source object.
- Keeps function block/interface declarations, implementations, methods, properties, and actions together in that object file with `// blark:begin ...` section markers.
- Writes a manifest file, `blark_twincat.json`, which records how each `.st` file maps back to the native TwinCAT source.
- Fails loudly on unsupported compile items, malformed XML, inconsistent project references, or overwrite conflicts.

`blark project encode`:

- Reads a previously decoded folder.
- Validates the manifest, `native/`, and `st/` contents before writing output.
- Parses every edited `.st` file again to ensure the round-trip result is still valid.
- Applies only the changed Structured Text blocks back into a copied native TwinCAT tree.
- Refuses to proceed when files are missing, extra `.st` files appear, identifiers drift, or rewrite safety checks fail.

Structured folder layout:

```text
structured/
  blark_twincat.json
  native/
    ...
  st/
    ...
```

Typical workflows:

```bash
blark project decode path/to/project.sln out/structured --overwrite
blark project encode out/structured out/native --overwrite
```

### Windows executable

The single-file executable behaves the same as the Python entry point:

```bash
dist/blark.exe --help
dist/blark.exe parse path/to/file.TcPOU
dist/blark.exe project decode path/to/project.sln out/structured --overwrite
```

## Sample runs

Run the parser or experimental formatter utility.  Current supported file types
include those from TwinCAT3 projects ( ``.sln``, ``.tsproj``, ``.plcproj``,
``.TcPOU``, ``.TcGVL``, ``.TcDUT``, ``.TcIO``, ``.TcTTO``) and plain-text
``.st`` files.

```bash
$ blark parse --print-tree blark/tests/POUs/F_SetStateParams.TcPOU
function_declaration
  None
  F_SetStateParams
  indirect_simple_specification
    None
    simple_specification        BOOL
  input_declarations
    None
    var1_init_decl
      var1_list
... (clipped) ...
```

To interact with the Python dataclasses directly, make sure IPython is
installed first and then try:

```
$ blark parse --interactive blark/tests/POUs/F_SetStateParams.TcPOU
# Assuming IPython is installed, the following prompt will come up:

In [1]: results[0].identifier
Out[1]: 'F_SetStateParams/declaration'

In [2]: results[1].identifier
Out[2]: 'F_SetStateParams/implementation'
```

Dump out a parsed and reformatted set of source code:

```bash
$ blark format blark/tests/source/array_of_objects.st
{attribute 'hide'}
METHOD prv_Detection : BOOL
    VAR_IN_OUT
        currentChannel : ARRAY [APhase..CPhase] OF class_baseVector(SIZEOF(vector_t), 0);
    END_VAR
END_METHOD
```

blark supports rewriting TwinCAT source code files directly as well:

```bash
$ blark format blark/tests/POUs/F_SetStateParams.TcPOU

<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="F_SetStateParams" Id="{f9611d23-4bb5-422d-9f11-2cc94e61fc9e}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION F_SetStateParams : BOOL
    VAR_INPUT
        nStateRef : UDINT;
        rPosition : REAL;
        rTolerance : REAL;
        stBeamParams : ST_BeamParams;

... (clipped) ...
```

It is also possible to parse the source code into a tokenized ``SourceCode``
tree which supports code introspection and rewriting:

```python
In [1]: import blark

In [2]: parsed = blark.parse_source_code(
   ...:     """
   ...: PROGRAM ProgramName
   ...:     VAR_INPUT
   ...:         iValue : INT;
   ...:     END_VAR
   ...:     VAR_ACCESS
   ...:         AccessName : SymbolicVariable : TypeName READ_WRITE;
   ...:     END_VAR
   ...:     iValue := iValue + 1;
   ...: END_PROGRAM
   ...: """
   ...: )

# Access the lark Tree here:
In [3]: parsed.tree.data
Out[3]: Token('RULE', 'iec_source')

# Or the transformed information:
In [3]: transformed = parsed.transform()

In [4]: program = transformed.items[0]

In [5]: program.declarations[0].items[0].variables[0].name
Out[5]: Token('IDENTIFIER', 'iValue')
```

The supported starting grammar rules for the reusable parser include:

```
"iec_source"
"action"
"data_type_declaration"
"function_block_method_declaration"
"function_block_property_declaration"
"function_block_type_declaration"
"function_declaration"
"global_var_declarations"
"program_declaration"
"statement_list"
```

Other starting rules remain possible for advanced users, however a new parser
must be created in that scenario and transformations are not supported.

Additionally, please note that you should avoid creating parsers on-the-fly as
there is a startup cost to re-parsing the grammar. Utilize the provided parser
from ``blark.get_parser()`` whenever possible.

```
In [1]: import blark

In [2]: parser = blark.new_parser(start=["any_integer"])

In [3]: Tree('hex_integer', [Token('HEX_STRING', '1010')])
```

## Adding Test Cases

Presently, test cases are provided in two forms. Within the `blark/tests/`
directory there are `POUs/` and `source/` directories.

TwinCAT source code files belong in ``blark/tests/POUs``.
Plain-text source code files (e.g., ``.st`` files) belong in
``blark/tests/source``.

Feel free to contribute your own test cases and we'll do our best to ensure
that blark parses them (and continues to parse them) without issue.

## Acknowledgements

Originally based on Volker Birk's IEC 61131-3 grammar
[iec2xml](https://fdik.org/iec2xml/) (GitHub fork
[here](https://github.com/klauer/iec2xml)) and [A Syntactic
Specification for the Programming Languages of theIEC 61131-3
Standard](https://www.researchgate.net/publication/228971719_A_syntactic_specification_for_the_programming_languages_of_the_IEC_61131-3_standard)
by Flor Narciso et al.  Many aspects of the grammar have been added to,
modified, and in cases entirely rewritten to better support lark grammars and
transformers.

Special thanks to the blark contributors:

- @engineerjoe440

## Related, Similar, or Alternative Projects

There are a number of similar, or related projects that are available.

- ["MATIEC"](https://github.com/nucleron/matiec) - another IEC 61131-3 Structured
Text parser which supports IEC 61131-3 second edition, without classes,
namespaces and other fancy features. An updated version is also
[available on Github](https://github.com/sm1820/matiec)
- [OpenPLC Runtime Version 3](https://github.com/thiagoralves/OpenPLC_v3) -
As stated by the project:
  > OpenPLC is an open-source Programmable Logic Controller that is based on easy to use software. Our focus is to provide a low cost industrial solution for automation and research. OpenPLC has been used in many research papers as a framework for industrial cyber security research, given that it is the only controller to provide the entire source code.
- [RuSTy](https://github.com/PLC-lang/rusty)
[documentation](https://plc-lang.github.io/rusty/intro_1.html) - Structured text
compiler written in Rust. As stated by the project:
  > RuSTy is a structured text (ST) compiler written in Rust. RuSTy utilizes the LLVM framework to compile eventually to native code.
- [IEC Checker](https://github.com/jubnzv/iec-checker) - Static analysis tool
for IEC 61131-3 logic. As described by the maintainer:
  > iec-checker has the ability to parse ST source code and dump AST and CFG to JSON format, so you can process it with your language of choice.
- [TcBlack](https://github.com/Roald87/TcBlack) - Python black-like code formatter for TwinCAT code.
