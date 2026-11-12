from datetime import datetime, timezone

import pytest

from app import judge
from app.checks import claims_supported, sources_for
from app.evaluate import load_metrics
from app.schemas import Run

grok_run = {
    "id": "r1",
    "received_at": datetime.now(timezone.utc),
    "agent_name": "grok-bot",
    "input": "How much is the Grok subscription?",
    "output": "The Grok subscription is $15 a month. Premium+ is $40 a month. You can cancel anytime.",
    "context": ["Pricing page: Grok Premium costs $8 per month. Premium+ costs $40 per month."],
    "steps": [{"type": "tool_call", "name": "get_latest_prices", "error": "could not update"}],
}

groundedness = next(metric for metric in load_metrics() if metric.id == "groundedness")


def fake_judge(monkeypatch, claims, verdicts):
    """Answer the first judge call with claims and the second with verdicts."""
    def ask(prompt, shape, model=None):
        if "claims" in shape["properties"]:
            return {"claims": claims}
        return {"verdicts": [{**v, "claim_id": number} for number, v in enumerate(verdicts, start=1)]}
    monkeypatch.setattr(judge, "ask", ask)


def verdict(claim, kind, quote="", reason="..."):
    return {"claim": claim, "verdict": kind, "quote": quote, "reason": reason}


def test_wrong_price_explains_why(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["The Grok subscription is $15 a month.", "Premium+ is $40 a month.", "You can cancel anytime."],
        verdicts=[
            verdict("The Grok subscription is $15 a month.", "contradicted", "Grok Premium costs $8 per month."),
            verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month."),
            verdict("You can cancel anytime.", "not_mentioned"),
        ],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)

    assert outcome.score == pytest.approx(1 / 3)
    assert [e.verdict for e in outcome.evidence] == ["failed", "passed", "missing"]
    assert 'Contradicted: "The Grok subscription is $15 a month." (the sources say "Grok Premium costs $8 per month.")' in outcome.reason
    assert 'Not in the sources: "You can cancel anytime."' in outcome.reason
    assert "get_latest_prices" not in outcome.reason  # linking failed steps to wrong claims is diagnosis's job
    assert outcome.judge_model == "qwen3:8b"
    assert outcome.judge_prompt_version == "groundedness-v4"


def test_all_claims_backed(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month.")],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)
    assert outcome.score == 1.0
    assert outcome.reason == "All 1 claims are backed by the sources."


def test_made_up_quote_is_flagged(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ is on sale for $40.")],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)
    assert "the judge's quote isn't in the text it was checking against" in outcome.evidence[0].note
    assert "treat this result with care" in outcome.reason


def test_no_sources_is_skipped():
    # no context, and the only step failed, so the agent looked nothing up
    outcome = claims_supported(Run(**{**grok_run, "context": []}), groundedness)
    assert outcome.score is None
    assert outcome.skipped_reason == "the run has no sources to check the answer against (no context or tool results)"


def test_judge_down_is_skipped_not_failed(monkeypatch):
    def broken(prompt, shape, model=None):
        raise judge.JudgeError("couldn't reach Ollama at http://localhost:11434 (ConnectError)")
    monkeypatch.setattr(judge, "ask", broken)

    outcome = claims_supported(Run(**grok_run), groundedness)
    assert outcome.score is None
    assert "the judge didn't answer: couldn't reach Ollama" in outcome.skipped_reason


def test_judge_model_setting_on_the_machine_wins(monkeypatch):
    monkeypatch.setenv("JUDGE_MODEL", "llama3.2")
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month.")],
    )
    assert claims_supported(Run(**grok_run), groundedness).judge_model == "llama3.2"


# ---------- Tool and retrieval results count as sources (e.g. a football agent with no documents) ----------

football_run = {
    "id": "r2",
    "received_at": datetime.now(timezone.utc),
    "agent_name": "football-bot",
    "input": "Who do Arsenal play next?",
    "output": "Arsenal play Liverpool on Sunday.",
    "steps": [
        {"type": "tool_call", "name": "get_fixtures", "output": {"next_match": "Arsenal vs Chelsea, Saturday 3pm"}},
        {"type": "tool_call", "name": "get_table", "error": "timeout"},
        {"type": "llm_call", "name": "write_answer", "output": "Arsenal play Liverpool on Sunday."},
    ],
}


def capture_check_prompt(monkeypatch):
    """Fake judge that records the prompt it was sent when checking claims."""
    sent = {}

    def ask(prompt, shape, model=None):
        if "claims" in shape["properties"]:
            return {"claims": ["Arsenal play Liverpool on Sunday."]}
        sent["prompt"] = prompt
        return {"verdicts": [{**verdict("Arsenal play Liverpool on Sunday.", "contradicted", "Arsenal vs Chelsea, Saturday 3pm"), "claim_id": 1}]}
    monkeypatch.setattr(judge, "ask", ask)
    return sent


def test_tool_result_is_a_source_when_there_is_no_context(monkeypatch):
    sent = capture_check_prompt(monkeypatch)
    outcome = claims_supported(Run(**football_run), groundedness)

    assert outcome.score == 0.0
    assert """[tool call 'get_fixtures'] {"next_match": "Arsenal vs Chelsea, Saturday 3pm"}""" in sent["prompt"]
    assert "Warning" not in outcome.evidence[0].note  # the judge's quote is found in the tool result


def test_quote_inside_a_json_list_is_found(monkeypatch):
    fixture = "Arsenal vs Chelsea, Saturday 3pm"
    fake_judge(
        monkeypatch,
        claims=["Arsenal play Liverpool on Sunday."],
        verdicts=[verdict("Arsenal play Liverpool on Sunday.", "contradicted", fixture)],
    )
    steps = [{"type": "tool_call", "name": "get_fixtures", "output": {"fixtures": [fixture, "Spurs vs Leeds"]}}]
    outcome = claims_supported(Run(**{**football_run, "steps": steps}), groundedness)
    assert "Warning" not in outcome.evidence[0].note


def test_quote_with_a_copied_label_is_found(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", f"[context 1] {grok_run['context'][0]}")],
    )
    assert "Warning" not in claims_supported(Run(**grok_run), groundedness).evidence[0].note


def test_no_verdicts_from_the_judge_is_skipped_not_failed(monkeypatch):
    fake_judge(monkeypatch, claims=["Premium+ is $40 a month."], verdicts=[])
    outcome = claims_supported(Run(**grok_run), groundedness)
    assert outcome.score is None
    assert outcome.could_not_run


def outcome_with_raw_verdicts(monkeypatch, raw):
    claims = ["Premium+ is $40 a month.", "Grok Premium is $8 a month."]

    def ask(prompt, shape, model=None):
        return {"claims": claims} if "claims" in shape["properties"] else {"verdicts": raw}
    monkeypatch.setattr(judge, "ask", ask)
    return claims_supported(Run(**grok_run), groundedness)


def raw(claim_id):
    return {"claim_id": claim_id, "verdict": "not_mentioned", "quote": "", "reason": "..."}


@pytest.mark.parametrize(
    "answered",
    [[1], [1, 1], [1, 3], [1, 2, 2]],
    ids=["dropped", "duplicate-instead-of-second", "unknown-id", "extra"],
)
def test_wrong_set_of_claim_ids_is_skipped_not_scored(monkeypatch, answered):
    outcome = outcome_with_raw_verdicts(monkeypatch, [raw(number) for number in answered])
    assert outcome.score is None
    assert outcome.could_not_run


def test_claim_text_comes_from_us_and_order_is_restored(monkeypatch):
    outcome = outcome_with_raw_verdicts(monkeypatch, [raw(2), raw(1)])
    assert [e.item for e in outcome.evidence] == ["Premium+ is $40 a month.", "Grok Premium is $8 a month."]


def test_failed_steps_and_the_agents_own_writing_are_not_sources(monkeypatch):
    sent = capture_check_prompt(monkeypatch)
    claims_supported(Run(**football_run), groundedness)

    assert "get_table" not in sent["prompt"]      # failed step
    assert "write_answer" not in sent["prompt"]   # llm_call output is the agent's own writing


def test_same_text_in_context_and_retrieval_is_sent_once():
    run = Run(
        **{
            **grok_run,
            "steps": [{"type": "retrieval", "name": "search_pricing_docs", "output": grok_run["context"][0]}],
        }
    )
    assert sources_for(run) == [("context 1", grok_run["context"][0])]


# ---------- The agent's instructions are a source ----------

FOOTBALL_INSTRUCTIONS = (
    "You are a football data assistant. Answer using tool results only.\n"
    "Tools:\n- league_table: the current league table\n- top_scorers: the top scorers of a league"
)

purpose_run = {
    **grok_run,
    "agent_name": "football-agent",
    "input": "What is your purpose?",
    "output": "I am a football data assistant. I can show the current league table.",
    "context": ["The Scottish Premiership contains twelve clubs."],
    "steps": [],
    "instructions": FOOTBALL_INSTRUCTIONS,
}


def test_instructions_come_first_in_the_sources():
    assert sources_for(Run(**purpose_run))[0] == ("agent instructions", FOOTBALL_INSTRUCTIONS)
    assert all(label != "agent instructions" for label, _ in sources_for(Run(**grok_run)))  # only when sent


def test_what_the_agent_says_about_itself_is_backed_by_its_instructions(monkeypatch):
    """Claims the agent makes about itself are verified against its instructions (system prompt and tool descriptions)."""
    fake_judge(
        monkeypatch,
        claims=["The assistant is a football data assistant.", "The assistant can show the current league table."],
        verdicts=[
            verdict("The assistant is a football data assistant.", "supported", "You are a football data assistant."),
            verdict("The assistant can show the current league table.", "supported", "league_table: the current league table"),
        ],
    )
    outcome = claims_supported(Run(**purpose_run), groundedness)
    assert outcome.score == 1.0
    assert [e.found_in for e in outcome.evidence] == ["agent instructions", "agent instructions"]
    assert "2 of them by the agent's own instructions" in outcome.reason


def test_found_in_names_the_source_the_quote_is_in(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month.", "You can cancel anytime."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month."), verdict("You can cancel anytime.", "not_mentioned")],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)
    assert [e.found_in for e in outcome.evidence] == ["context 1", None]


def test_a_search_result_already_sent_as_context_is_read_once():
    """The football agent records search_knowledge as a step and copies its passages into context."""
    passages = [{"source": "formats.md", "text": "The Scottish Premiership contains twelve clubs."}, {"source": "formats.md", "text": "A win is worth three points."}]
    run = Run(
        **{
            **grok_run,
            "context": [f"[{p['source']}] {p['text']}" for p in passages],
            "steps": [
                {"type": "retrieval", "name": "search_knowledge", "output": passages},
                {"type": "tool_call", "name": "league_table", "output": [{"team": "Celtic", "points": 31}]},
            ],
        }
    )
    labels = [label for label, _ in sources_for(run)]
    assert labels == ["context 1", "context 2", "tool call 'league_table'"]  # the search isn't listed again
