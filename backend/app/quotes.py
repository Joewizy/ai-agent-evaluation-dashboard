"""Verification that a judge's quotation occurs in the source it cites.

The AI judge supports each claim verdict with a quotation from the sources. This module checks that
the quotation exists in the cited text, so that fabricated evidence is detected before a verdict is used.

Two match modes are supported:

``exact``
    Every sentence of the quotation occurs in the source after normalisation (case folding, removal of
    punctuation and JSON syntax). This is the expected mode for prose sources.

``record``
    Applied only when the source is JSON (typically a tool result) and the exact match fails. Judge
    models tend to render a record such as
    ``{"player": "Camilo Andres Durán Marquez", "goals": 7, "position": 1}`` as the sentence
    "Camilo Andres Durán Marquez, with 7 goals, is in position 1." A sentence matches a record when all
    of the following conditions hold for that single record:

    a. the sentence contains one of the record's string values, which identifies the record;
    b. every number in the sentence is a numeric value of the record;
    c. every capitalised word in the sentence occurs in the record, so no foreign proper nouns are present;
    d. the sentence contains no string value that belongs to a different record.

    Requiring all four conditions within one record prevents values from several records being
    combined into a single sentence.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal

# A source label the judge may copy from its prompt, e.g. "[context 2] ...". Stripped before matching.
SOURCE_LABEL = re.compile(r"^\s*\[(agent instructions|context \d+|tool call '[^']*'|retrieval '[^']*'|answer key|answer)\]", re.IGNORECASE)
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")

# Excluded from condition (c): sentence-initial function words and generic field names, which are
# capitalised by position rather than because they are proper nouns.
NOT_NAMES = {
    "the", "a", "an", "in", "on", "at", "with", "and", "of", "for", "to", "by", "from", "is", "are", "was",
    "he", "she", "it", "they", "his", "her", "their", "its", "this", "that", "these", "there", "who", "which",
    "position", "rank", "team", "player", "club", "goals", "points", "season", "league",
}

Found = Literal["exact", "record"]


def words_only(text: str) -> str:
    """Normalise text to lowercase word, number and currency-symbol tokens separated by single spaces."""
    return " ".join(re.findall(r"[^\W_]+|[%€$£+]", text.lower()))


def numbers_in(text: str) -> set[float]:
    """All numeric literals in the text as floats, so that "7", "7.0" and "1,240" compare by value."""
    found = set()
    for raw in NUMBER.findall(text):
        try:
            found.add(float(raw.replace(",", "")))
        except ValueError:
            pass
    return found


@dataclass
class Record:
    """A flattened JSON object: its string values, its numeric values, and every word in its keys and values."""

    names: list[str] = field(default_factory=list)  # string values after words_only(), e.g. "camilo andres durán marquez"
    numbers: set[float] = field(default_factory=set)
    words: set[str] = field(default_factory=set)


def json_records(text: str) -> list[Record]:
    """All JSON objects in the text at any nesting depth. Returns an empty list when the text is not valid JSON."""
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    records: list[Record] = []

    def leaves(node: Any, record: Record) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                record.words.update(words_only(str(key)).split())
                leaves(value, record)
        elif isinstance(node, list):
            for item in node:
                leaves(item, record)
        elif isinstance(node, bool) or node is None:
            return
        elif isinstance(node, (int, float)):
            record.numbers.add(float(node))
        else:
            value = words_only(str(node))
            record.words.update(value.split())
            record.numbers.update(numbers_in(str(node)))
            if len(value) >= 3 and not value.replace(" ", "").isdigit():
                record.names.append(value)

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            record = Record()
            leaves(node, record)
            records.append(record)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    return records


def in_record(sentence: str, record: Record, others: list[Record]) -> bool:
    """Whether the sentence satisfies conditions (a) to (d) for this record. `others` is the full record list, used by (d)."""
    words = f" {words_only(sentence)} "
    named = [name for name in record.names if f" {name} " in words]
    if not named:  # (a) the sentence identifies this record
        return False
    if not numbers_in(sentence) <= record.numbers:  # (b) every number belongs to this record
        return False
    capitals = {w.lower() for w in re.findall(r"[^\W\d_]+", sentence) if w[0].isupper()} - NOT_NAMES
    if not capitals <= record.words:  # (c) every capitalised word occurs in this record
        return False
    for other in others:  # (d) no string value of a different record is present
        if other is record:
            continue
        for name in other.names:
            if f" {name} " in words and name not in record.names:
                return False
    return True


def find_quote(quote: str, text: str) -> Found | None:
    """Return the mode ("exact" or "record") under which every sentence of the quotation is found in the text, or None.

    Sentences are matched independently and in any order: judges commonly reorder sentences or quote
    two rows of a table in one quotation.
    """
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", SOURCE_LABEL.sub(" ", quote)) if words_only(s)]
    if not sentences:
        return None
    target = f" {words_only(text)} "
    records: list[Record] | None = None
    how: Found = "exact"
    for sentence in sentences:
        if f" {words_only(sentence)} " in target:
            continue
        if records is None:
            records = json_records(text)
        if any(in_record(sentence, record, records) for record in records):
            how = "record"
            continue
        return None
    return how


def quote_is_in(quote: str, text: str) -> bool:
    """Whether the quotation is found in the text under either match mode."""
    return find_quote(quote, text) is not None
