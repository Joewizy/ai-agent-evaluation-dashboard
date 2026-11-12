"""Tests for quote verification: exact matching for prose and record matching for JSON sources.

TOP_SCORERS is the payload the football agent's top_scorers tool returned on a run of 10 November 2026.
"""

import json

from app.quotes import find_quote, quote_is_in

TOP_SCORERS = json.dumps(
    [
        {"position": 1, "player": "Camilo Andres Durán Marquez", "team": "Celtic", "goals": 7},
        {"position": 2, "player": "Jacob Murrell", "team": "Falkirk", "goals": 7},
        {"position": 3, "player": "Ryan Don Naderi", "team": "Hearts", "goals": 6},
    ],
    ensure_ascii=False,
)


def test_the_real_reworded_quote_is_found_as_a_record():
    # The quotation qwen3:8b produced for this record on the 10 November run.
    assert find_quote("Camilo Andres Durán Marquez, with 7 goals, is in position 1.", TOP_SCORERS) == "record"


def test_a_wrong_number_is_still_caught():  # condition (b)
    assert not quote_is_in("Camilo Andres Durán Marquez, with 9 goals, is in position 1.", TOP_SCORERS)
    assert not quote_is_in("Ryan Don Naderi has 7 goals.", TOP_SCORERS)  # 7 belongs to a different record


def test_facts_from_two_rows_cannot_be_stitched_together():  # condition (d)
    assert not quote_is_in("Camilo Andres Durán Marquez and Jacob Murrell are in position 1.", TOP_SCORERS)


def test_a_made_up_name_is_still_caught():  # condition (c)
    assert not quote_is_in("Camilo Andres Durán Marquez of Rangers has 7 goals.", TOP_SCORERS)


def test_it_must_name_a_record():  # condition (a)
    assert not quote_is_in("The top scorer has 7 goals.", TOP_SCORERS)


def test_two_sentences_can_come_from_two_rows():
    quote = "Jacob Murrell, with 7 goals, is in position 2. Ryan Don Naderi, with 6 goals, is in position 3."
    assert find_quote(quote, TOP_SCORERS) == "record"


def test_team_names_shared_by_rows_are_fine():
    rows = json.dumps([{"player": "Kasper Høgh", "team": "Celtic", "goals": 3}, {"player": "Adam Idah", "team": "Celtic", "goals": 2}])
    assert quote_is_in("Kasper Høgh of Celtic has 3 goals.", rows)


def test_nested_records_work():
    data = json.dumps({"data": {"standings": [{"position": 2, "participant": {"name": "Hearts"}, "points": 42}]}})
    assert find_quote("Hearts are second in position 2 with 42 points.", data) == "record"
    assert not quote_is_in("Hearts are in position 2 with 45 points.", data)


def test_plain_text_still_needs_the_exact_words():
    text = "Pricing page: Grok Premium costs $8 per month."
    assert find_quote("Grok Premium costs $8 per month.", text) == "exact"
    assert not quote_is_in("Grok Premium is $8 every month.", text)  # record matching applies to JSON sources only


def test_exact_words_in_json_are_still_exact():
    assert find_quote('"player": "Jacob Murrell"', TOP_SCORERS) == "exact"
