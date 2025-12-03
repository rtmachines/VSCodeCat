"""Syntax-highlighted HTML file writer."""
from __future__ import annotations

import dataclasses
import pathlib
from typing import Any, Optional, Union

import lark
from lxml import etree

from .output import OutputBlock, register_output_handler


@dataclasses.dataclass(frozen=True)
class CodeSpan:
    #: Start position (inclusive)
    start: int
    #: End position (exclusive)
    end: int

    @staticmethod
    def of(item: Union[lark.Tree, lark.Token]) -> Optional[CodeSpan]:
        """Get the code span of the given Tree or Token"""
        ref = item.meta if isinstance(item, lark.Tree) else item
        if (start := getattr(ref, 'start_pos', None)) is not None:
            if (end := getattr(ref, 'end_pos', None)) is not None:
                return CodeSpan(start, end)
        return None

    def contains(self, other: CodeSpan) -> bool:
        """Determine if the code span contains another code span"""
        return other.start >= self.start and other.end <= self.end


class RemoveNone(lark.Transformer):
    """Remove all None elements from a lark tree"""
    def __default__(
        self,
        data: lark.Token,
        children: list,
        meta: lark.tree.Meta
    ) -> lark.Tree:
        return lark.Tree(data, [c for c in children if c is not None], meta)


@dataclasses.dataclass(frozen=True)
class TokenPlacement:
    #: Token's parent tree
    tree: lark.Tree
    #: Index of the token in tree.children
    child_index: int


def find_placement(
    token: lark.Token,
    tree: lark.Tree
) -> Optional[TokenPlacement]:
    """Find a placement for the token within the given tree according to token's code span."""
    tree_span = CodeSpan.of(tree)
    token_span = CodeSpan.of(token)

    if not (tree_span and token_span and tree_span.contains(token_span)):
        return None

    for child in tree.children:
        if isinstance(child, lark.Tree):
            if placement := find_placement(token, child):
                return placement

    for index, child in enumerate(tree.children):
        child_span = CodeSpan.of(child)
        if child_span and child_span.start > token_span.start:
            return TokenPlacement(tree, index)

    return TokenPlacement(tree, len(tree.children))


def insert_comments(
    tree: lark.Tree,
    comments: list[lark.Token],
    source_code: str
) -> lark.Tree:
    """Combine code and comments into a single lark tree"""
    if not comments:
        return tree

    all_spans = [CodeSpan.of(tree)] + [CodeSpan.of(token) for token in comments]
    valid_spans = [span for span in all_spans if span]

    meta = lark.tree.Meta()
    meta.start_pos = min(span.start for span in valid_spans)
    meta.end_pos = max(span.end for span in valid_spans)

    # Use no-op transformer to create a copy of the tree.
    new_tree: lark.Tree = lark.Transformer().transform(tree)
    # Assign metadata to the copied tree.
    new_tree = lark.Tree(new_tree.data, new_tree.children, meta)

    for comment in comments:
        if placement := find_placement(comment, new_tree):
            placement.tree.children.insert(placement.child_index, comment)

    return new_tree


def html_element(*, cls: str, text: str = None) -> etree.Element:
    """Create a HTML element with the given class"""
    element = etree.Element("span")
    element.set("class", cls)
    if text is not None:
        element.text = text
    return element


def lark_item_to_element(
    item: Union[lark.Tree, lark.Token],
    source_code: str,
    output_pos: int
) -> tuple[etree.Element, int]:
    """
    Convert a lark item to an lxml element. Return the element and the position in the source code
    after this item.
    """
    code_span = CodeSpan.of(item) or CodeSpan(output_pos, output_pos)

    if isinstance(item, lark.Tree):
        element = html_element(cls=item.data)
        running_pos = code_span.start

        def append_text_up_to(pos: int):
            nonlocal running_pos
            if text := source_code[running_pos:pos]:
                if len(element) == 0:
                    element.text = text
                else:
                    element[-1].tail = text
            running_pos = pos

        for child in item.children:
            if child_span := CodeSpan.of(child):
                append_text_up_to(child_span.start)

            child_element, running_pos = lark_item_to_element(child, source_code, running_pos)
            element.append(child_element)

        append_text_up_to(code_span.end)
    else:
        assert isinstance(item, lark.Token)
        element = html_element(
            cls=item.type,
            text=source_code[code_span.start:code_span.end])

    return element, code_span.end


@dataclasses.dataclass
class HtmlWriter:
    user: Any
    source_filename: Optional[pathlib.Path]
    block: OutputBlock

    def to_html(self) -> str:
        """Format source code as HTML"""
        origin = self.block.origin
        assert origin is not None
        assert origin.tree is not None

        cleaned_tree = RemoveNone().transform(origin.tree)
        tree_with_comments = insert_comments(cleaned_tree, origin.comments, origin.source_code)

        root = html_element(cls="blark")

        origin_section = html_element(
            cls="blark_origin",
            text=origin.identifier or '')
        root.append(origin_section)

        code_section = html_element(cls="blark_code")

        # Handle any leading text before the tree
        tree_span = CodeSpan.of(tree_with_comments) or CodeSpan(0, 0)
        if leading := origin.source_code[0:tree_span.start]:
            code_section.text = leading

        # Convert code tree to lxml tree.
        element, _ = lark_item_to_element(
            tree_with_comments, origin.source_code, tree_span.start
        )
        code_section.append(element)
        root.append(code_section)

        # Serialize to HTML.
        return etree.tostring(root, encoding='unicode', method='html')

    @staticmethod
    def save(
        user: Any,
        source_filename: Optional[pathlib.Path],
        parts: list[OutputBlock],
    ) -> str:
        """Convert the source code block to HTML and return it."""
        result = []
        for part in parts:
            writer = HtmlWriter(user, source_filename, part)
            result.append(writer.to_html())

        return "\n\n".join(result)


def _register():
    """Register the HTML output file handlers."""
    register_output_handler("html", HtmlWriter.save)
    register_output_handler(".htm", HtmlWriter.save)
    register_output_handler(".html", HtmlWriter.save)


def format_file_as_html(
    input_filename: pathlib.Path | str,
    *,
    header: str = "<html><body>",
    footer: str = "</body></html>",
) -> str:
    """
    Helper for formatting a file as HTML.

    Parameters
    ----------
    input_filename : pathlib.Path or str
        The source code filename. Any supported by `blark.parse`.
    header : str, optional
        HTML header to include in the output.
        Defaults to html and body opening tags.
    footer : str, optional
        HTML footer to include in the output.
        Defaults to html and body closing tags.

    Note
    ----
    Users would typically format a file through blark's CLI by way of
    `blark format --output-format html`.
    """
    from .format import get_reformatted_code_blocks
    from .parse import parse

    input_filename = pathlib.Path(input_filename)
    results = parse(input_filename)
    blocks = get_reformatted_code_blocks(list(results), filename=input_filename)
    body = HtmlWriter.save(user=None, source_filename=input_filename, parts=blocks)
    return "".join((header, body, footer))
