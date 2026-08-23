"""Time, injected, so that a test of a scheduler does not have to wait for one.

Every module that asks what time it is takes a :class:`Clock`. :class:`FixedClock`
is the whole reason for the indirection: a quiet window that ends at 06:00 is
tested by setting the clock to 05:59:59 and stepping over it, not by sleeping
for a second and hoping. A scheduler tested with real time is a scheduler with
one slow test per boundary, and the boundaries are where the bugs are.

``monotonic`` is separate from ``now`` because they answer different questions.
``now`` is wall time, which is what a schedule is written in and what can jump
when NTP corrects it. ``monotonic`` is for measuring how long something took --
a lease, a long poll -- where a wall-clock jump backwards would otherwise read
as negative elapsed time.
"""

from __future__ import annotations

import time as _time


class Clock:
    """Wall time and monotonic time, as the operating system reports them."""

    def now(self) -> float:
        """Seconds since the Unix epoch, UTC."""
        return _time.time()

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin that never goes backwards."""
        return _time.monotonic()

    def sleep(self, seconds: float) -> None:
        """Block for ``seconds``. Negative and zero return immediately."""
        if seconds > 0:
            _time.sleep(seconds)


class FixedClock(Clock):
    """A clock the test moves by hand.

    ``sleep`` advances the clock instead of blocking, so code that sleeps in a
    loop runs at full speed under test while still observing time passing --
    which is what makes a lease-expiry test a millisecond rather than half an
    hour.
    """

    def __init__(self, t: float) -> None:
        self._t = float(t)
        self._mono = 0.0

    def now(self) -> float:
        return self._t

    def monotonic(self) -> float:
        return self._mono

    def sleep(self, seconds: float) -> None:
        self.advance(seconds)

    def advance(self, seconds: float) -> None:
        """Move both clocks forward. Negative moves only wall time.

        Monotonic time refuses to go backwards even here, because the whole
        point of it is that it cannot, and a test that could make it would be
        testing something the production clock will never do.
        """
        self._t += seconds
        if seconds > 0:
            self._mono += seconds

    def set(self, t: float) -> None:
        """Put wall time at an absolute instant, leaving monotonic time alone."""
        self._t = float(t)
