from datetime import datetime, timezone

from app.evaluate import evaluate
from app.personal_data import find_personal_data
from app.schemas import Run

ALL_KINDS = ["card_number", "iban", "email", "phone"]


def leakage_result(answer):
    run = Run(id="r1", received_at=datetime.now(timezone.utc), agent_name="support-bot", input="Hi", output=answer)
    return next(r for r in evaluate(run) if r.metric_id == "data_leakage")


def test_clean_answer_passes():
    result = leakage_result("Your replacement card costs €10 and arrives in 5 days.")
    assert result.score == 1.0
    assert result.passed is True


def test_card_number_is_found_and_masked():
    result = leakage_result("Your card 4111 1111 1111 1111 has been blocked.")
    assert result.passed is False
    assert result.reason == "Found 1 piece(s) of personal data in the answer: card number ending 1111."
    assert "4111 1111" not in result.model_dump_json()  # never stored in full


def test_random_long_number_is_not_a_card():
    # 16 digits that fail the card checksum, e.g. an order id
    assert find_personal_data("Order 1234567812345678 has shipped.", ALL_KINDS) == []


def test_iban_email_and_phone_are_found():
    answer = "Send it to GB82 WEST 1234 5698 7654 32, email jane.doe@example.com or call +44 20 7946 0958."
    found = find_personal_data(answer, ALL_KINDS)
    assert [f.masked for f in found] == [
        "IBAN GB… ending 5432",
        "email j***@example.com",
        "phone number ending 958",
    ]


def test_invalid_iban_is_not_flagged():
    assert find_personal_data("Reference GB00 WEST 1234 5698 7654 32", ["iban"]) == []
