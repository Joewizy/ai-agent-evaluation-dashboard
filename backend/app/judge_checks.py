"""Plain-code checks on the judge's own answers. See notes/design.md, "When the evaluation judge itself is wrong".

These can't prove the judge right or wrong. They only spot answers that don't hold together, which
count against any explanation resting on them and show up as caveats. Each check is cheap and deterministic.
"""

import re

from app.schemas import Evidence

# Words that say nothing about what a sentence is about: two fixtures can both be on a Sunday.
IGNORED_WORDS = set(
    """
    a an the is are was were be been it its this that these those there on in at of to for by with and or but
    per from as has have had can will would not no you your they their we our i he she his her
    monday tuesday wednesday thursday friday saturday sunday
    january february march april may june july august september october november december
    second minute hour day week month year am pm usd eur gbp euro dollar pound
    """.split()
)

SAYS_NOT_BACKED = ("not supported", "unsupported", "does not support", "doesn't support", "not mentioned", "does not mention", "doesn't mention", "not stated")
SAYS_BACKED = ("is supported", "are supported", "fully supported")
DENIES_CONTRADICTION = ("no contradiction", "not contradict", "doesn't contradict", "not contradicted")


def subject_words(text: str) -> set[str]:
    """The words that say what a sentence is about: no numbers, dates, units or filler. 'fees' and 'fee' count as one."""
    words = re.findall(r"[^\W\d_]+", text.lower())
    stems = {word.rstrip("s") for word in words if word not in IGNORED_WORDS}
    return {stem for stem in stems if stem and stem not in IGNORED_WORDS}


def same_word(a: str, b: str) -> bool:
    """'withdraw' and 'withdrawals' count as the same word. Short words must match exactly."""
    return a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)))


def shares_a_word(first: set[str], second: set[str]) -> bool:
    return any(same_word(a, b) for a in first for b in second)


def numbers_in(text: str) -> set[str]:
    return {number.replace(",", "") for number in re.findall(r"\d+(?:[.,]\d+)*", text)}


def quote_problems(evidence: Evidence) -> list[tuple[str, str]]:
    """Problems with a quote we did find in the reference, as (short name, what we checked)."""
    quote = evidence.source or ""
    if evidence.verdict == "failed":
        # Values differ in a real contradiction ($15 vs $8), so only the subject has to match.
        claim, quoted = subject_words(evidence.item), subject_words(quote)
        if claim and quoted and not shares_a_word(claim, quoted):
            return [("quote-off-topic", f'The judge\'s quote "{quote}" shares no words with the claim "{evidence.item}", apart from numbers, dates and units.')]
    if evidence.verdict == "passed":
        absent = sorted(numbers_in(evidence.item) - numbers_in(quote))
        if absent:
            return [("quote-missing-number", f'The claim "{evidence.item}" has the number(s) {", ".join(absent)}, which aren\'t in the judge\'s quote "{quote}".')]
    return []


def answer_problems(evidence: Evidence) -> list[tuple[str, str]]:
    """Problems with how a verdict fits its own quote and reason, as (short name, what we checked)."""
    problems = []
    if evidence.verdict in ("passed", "failed") and not evidence.source:
        problems.append(("no-quote", f'The judge gave no quote for its verdict on "{evidence.item}".'))
    if evidence.verdict == "missing" and evidence.source:
        problems.append(("quote-on-not-mentioned", f'The judge said "{evidence.item}" isn\'t mentioned, but still quoted "{evidence.source}".'))

    reason = (evidence.note or "").lower().replace("’", "'")
    affirms_contradiction = "contradict" in reason and not any(phrase in reason for phrase in DENIES_CONTRADICTION)
    disagrees = (
        (evidence.verdict == "passed" and (affirms_contradiction or any(phrase in reason for phrase in SAYS_NOT_BACKED)))
        or (evidence.verdict == "failed" and any(phrase in reason for phrase in (*DENIES_CONTRADICTION, *SAYS_BACKED)))
        or (evidence.verdict == "missing" and (affirms_contradiction or any(phrase in reason for phrase in SAYS_BACKED)))
    )
    if disagrees:
        problems.append(("reason-disagrees", f'The judge\'s reason for its verdict on "{evidence.item}" uses wording that doesn\'t fit the verdict: "{evidence.note}"'))
    return problems
