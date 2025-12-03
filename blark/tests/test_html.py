from __future__ import annotations

import os
import pathlib

import pytest

from ..html import format_file_as_html
from . import conftest

parse_filenames = conftest.twincat_pou_filenames + conftest.structured_text_filenames


@pytest.fixture(params=parse_filenames)
def input_filename(request) -> pathlib.Path:
    if not os.path.exists(request.param):
        pytest.skip(f"File missing: {request.param}")
    return pathlib.Path(request.param)


def test_format_html(input_filename: pathlib.Path) -> None:
    print(format_file_as_html(input_filename))
