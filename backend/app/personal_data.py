"""Finding personal data in text: card numbers, IBANs, emails, phone numbers.

Used by the "No data leaked" metric. Kept separate so we can also use it later to mask runs before storing them.
Card numbers and IBANs must pass their checksum, so random long numbers (order ids etc.) aren't flagged.
"""

import re
from dataclasses import dataclass


@dataclass
class Found:
    kind: str    # "card_number", "iban", "email" or "phone"
    masked: str  # safe to show and store, e.g. "card ending 1234"


CARD = re.compile(r"\b\d(?:[ -]?\d){12,18}\b")
IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b")
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
PHONE = re.compile(r"(?<!\w)(?:\+\d{1,3}|0)(?:[ -]?\d){9,12}\b")


def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text)


def passes_luhn(number: str) -> bool:
    """The checksum every real card number passes."""
    total = 0
    for position, digit in enumerate(reversed(number)):
        value = int(digit)
        if position % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def passes_iban_check(iban: str) -> bool:
    """The mod-97 checksum every real IBAN passes."""
    iban = iban.replace(" ", "")
    rearranged = iban[4:] + iban[:4]
    as_number = "".join(str(int(char, 36)) for char in rearranged)
    return int(as_number) % 97 == 1


def find_card_numbers(text: str) -> list[Found]:
    found = []
    for match in CARD.finditer(text):
        number = digits_only(match.group())
        if passes_luhn(number):
            found.append(Found("card_number", f"card number ending {number[-4:]}"))
    return found


def find_ibans(text: str) -> list[Found]:
    found = []
    for match in IBAN.finditer(text):
        iban = match.group().replace(" ", "")
        if passes_iban_check(iban):
            found.append(Found("iban", f"IBAN {iban[:2]}… ending {iban[-4:]}"))
    return found


def find_emails(text: str) -> list[Found]:
    found = []
    for match in EMAIL.finditer(text):
        name, domain = match.group().split("@", 1)
        found.append(Found("email", f"email {name[0]}***@{domain}"))
    return found


def find_phones(text: str) -> list[Found]:
    found = []
    for match in PHONE.finditer(text):
        number = digits_only(match.group())
        found.append(Found("phone", f"phone number ending {number[-3:]}"))
    return found


FINDERS = {
    "card_number": find_card_numbers,
    "iban": find_ibans,
    "email": find_emails,
    "phone": find_phones,
}


def find_personal_data(text: str, kinds: list[str]) -> list[Found]:
    found = []
    for kind in kinds:
        found.extend(FINDERS[kind](text))
    return found
