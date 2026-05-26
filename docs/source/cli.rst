CLI Application
###############

The ``blark`` command-line application can be used for quick inspection,
reformatting, and TwinCAT project round-tripping without writing Python code.

Invocation
==========

You can invoke the CLI in any of these forms:

.. code:: bash

   $ blark --help
   $ python -m blark --help
   dist/blark.exe --help

The single-file Windows executable, when built, uses the same command layout
and options as the Python entry point.

Command overview
================

+-----------------+--------------------------------------------------+--------------------------------------------------------------+----------------------------------------------------------+
| Command         | Purpose                                          | Typical input                                                | Default output                                           |
+=================+==================================================+==============================================================+==========================================================+
| ``blark parse`` | Parse TwinCAT or plain Structured Text source    | ``.sln``, ``.tsproj``, ``.plcproj``, ``.TcPOU``,             | Console output, JSON, or summaries                       |
|                 | and inspect the results                          | ``.TcGVL``, ``.TcDUT``, ``.TcIO``, ``.TcTTO``, ``.st``       |                                                          |
+-----------------+--------------------------------------------------+--------------------------------------------------------------+----------------------------------------------------------+
| ``blark format``| Reformat parsed source code and optionally write | Same as ``parse``                                            | Reformatted code to stdout unless ``--overwrite`` or     |
|                 | it back out                                      |                                                              | ``--write-to`` is used                                   |
+-----------------+--------------------------------------------------+--------------------------------------------------------------+----------------------------------------------------------+
| ``blark project``| Decode and encode TwinCAT projects to and from  | Native TwinCAT artifacts or a previously decoded structured  | A structured folder (``decode``) or a native TwinCAT     |
|                 | a structured round-trip folder                   | folder                                                       | tree (``encode``)                                        |
+-----------------+--------------------------------------------------+--------------------------------------------------------------+----------------------------------------------------------+

Use ``--help`` to inspect command-specific flags:

.. code:: bash

   $ blark parse --help
   $ blark format --help
   $ blark project --help
   $ blark project decode --help
   $ blark project encode --help

blark parse
===========

Use ``blark parse`` when you want to inspect source code without modifying it.

Highlights:

- Parses a single file, a PLC project, or a full TwinCAT solution.
- Reports parse failures and exits with code ``1`` if any source block fails
  to parse.
- Supports ``--debug`` to continue past failures while still printing them.
- Supports ``--json`` for transformed output instead of tree-only inspection.
- Supports ``--summary`` for declaration and implementation summaries.
- Supports ``--filter`` to narrow parsing to matching identifiers or filenames.
- Supports ``--interactive`` to open an IPython or Python session with the
  parse results loaded.

Examples:

.. code:: bash

   $ blark parse --print-tree blark/tests/POUs/F_SetStateParams.TcPOU
   $ blark parse --summary blark/tests/twincat_root/SampleLibraryA/SampleLibraryA.sln
   $ blark parse --json blark/tests/source/array_of_objects.st

blark format
============

Use ``blark format`` when you want consistent source formatting or want to
rewrite TwinCAT XML-backed source files with reformatted Structured Text.

Highlights:

- Without ``--overwrite`` or ``--write-to``, formatted output is written to
  stdout.
- ``--overwrite`` writes back to the original source path.
- ``--write-to`` writes to a separate file or directory.
- ``--input-format`` forces the input loader when the extension is ambiguous.
- ``--output-format`` selects a specific writer when you do not want the input
  format preserved.
- ``--indent`` changes the indentation string used for formatted output.

Safe examples:

.. code:: bash

   $ blark format blark/tests/source/array_of_objects.st
   $ blark format --debug blark/tests/POUs/F_SetStateParams.TcPOU

Typical write workflows:

.. code:: bash

   blark format --overwrite path/to/file.TcPOU
   blark format --write-to out/ path/to/project.sln
   blark format --output-format html --write-to report.html path/to/file.st

blark project
=============

Use ``blark project`` when you want a round-trip friendly representation of a
TwinCAT project.

``blark project decode``
------------------------

``decode`` validates the source project and produces a structured folder.

It performs the following steps:

- Validates the input path, extension, TwinCAT layout, and supported file
  types.
- Copies the native project tree into ``native/``.
- Extracts editable Structured Text blocks into ``src/``, using one ``.st``
  file per semantic block.
- Writes machine-owned metadata under ``.blark/``, including
  ``.blark/manifest.json``, so each extracted ``.st`` file can be mapped back
  to its native TwinCAT source.
- Stops with a detailed error message when unsupported compile items,
  malformed XML, inconsistent project references, or overwrite conflicts are
  encountered.

``blark project encode``
------------------------

``encode`` consumes a previously decoded folder and produces a native TwinCAT
tree.

It performs the following steps:

- Validates the manifest, ``native/``, and ``src/`` contents before writing
  output.
- Parses every edited ``.st`` file again before rewriting native source.
- Applies only changed Structured Text blocks back into a copied native TwinCAT
  tree.
- Refuses to proceed when files are missing, extra ``.st`` files appear,
  identifiers drift, or rewrite safety checks fail.

Structured folder layout:

.. code:: text

   structured/
     blark.json
     README.md
     .blark/
       manifest.json
       index.json
       diagnostics.json
       cache/
     native/
       ...
     src/
       ...

Typical workflows:

.. code:: bash

   blark project decode path/to/project.sln out/structured --overwrite
   blark project encode out/structured out/native --overwrite

Single-file Windows executable
==============================

To build ``blark.exe`` as a single-file CLI on Windows:

.. code:: bash

   $ python -m pip install -r requirements-dev.txt
   $ python -m PyInstaller --clean --noconfirm blark.spec

The generated executable is written to ``dist/blark.exe``.

Examples:

.. code:: bash

   dist/blark.exe --help
   dist/blark.exe parse path/to/file.TcPOU
   dist/blark.exe project decode path/to/project.sln out/structured --overwrite
