"""The Hangul the faces carry, in one place for the generator and the validator.

KS X 1001's 2,350 완성형 syllables, derived from the EUC-KR codec rather than
tabulated: its Hangul block is lead 0xB0..0xC8 x trail 0xA1..0xFE and every one
of those pairs decodes to exactly one syllable. Derivation asserts the count.
"""
from __future__ import annotations


def _wansung() -> frozenset[str]:
    out = []
    for lead in range(0xB0, 0xC9):
        for trail in range(0xA1, 0xFF):
            try:
                out.append(bytes([lead, trail]).decode("euc-kr"))
            except UnicodeDecodeError:
                pass
    assert len(out) == 2350, f"expected 2350 KS X 1001 syllables, derived {len(out)}"
    return frozenset(out)


WANSUNG = _wansung()
COMPAT_JAMO = frozenset(chr(c) for c in range(0x3131, 0x318F))
CJK_PUNCT = frozenset("、。" + "".join(chr(c) for c in range(0x3008, 0x3010)))
DRAWABLE_KO = WANSUNG | COMPAT_JAMO | CJK_PUNCT


def is_syllable(c: str) -> bool:
    return 0xAC00 <= ord(c) <= 0xD7A3


def weight(s: str) -> int:
    """Characters of measure: a Hangul syllable is a full em, a Latin glyph half of one."""
    return sum(2 if is_syllable(c) else 1 for c in s)
