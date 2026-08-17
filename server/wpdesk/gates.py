"""The two gates a draft passes before it can become an edition.

Gate 1 asks whether the payload is a legal edition; gate 2 asks whether it
*prints*. They are separate questions and only the second one is expensive, so
they run cheapest first and the second is never reached when the first fails.

Both are subprocesses rather than reimplementations, and that is the point of
this module. ``tools/mock_news_server.py --validate`` is the reference producer
and the only thing that knows the contract well enough to judge an arbitrary
payload; ``tools/edition/render-check.sh`` runs the real ``news_core``, the real
faces, the real compositor and the real six-ink quantizer at 1200 x 1600. Both
already have tests around them. A second copy of either inside the desk would
be a second answer to maintain, and the day the two disagreed the desk's copy
would be the one that was wrong -- because the firmware is built from the
other.

Three things a gate must never do, each of which is a decision this module
makes rather than inherits:

* **Fail by raising.** A gate that throws loses the draft and, with it, the
  validator output that says why the draft was refused. That output is the
  entire product of a failed gate -- the producer is an agent, and an agent
  handed an exception cannot fix its own copy. So every failure, timeout
  included, comes back as ``GateResult(ok=False, output=...)``.
* **Hold everything it was told.** A failing render prints every layout
  assertion it can find, and a desk that kept all of it would hold megabytes
  per draft against a limit of eight open drafts.
* **Let caller data reach a shell.** This service is internet-reachable and
  this repository is public. Every invocation is a list argv with
  ``shell=False``; there is no string to quote and therefore nothing to get
  wrong.

:class:`StubGates` exists so ``editions.py``'s tests can assert the ordering
property -- that a failing validate means render is never run -- without a
CMake build in the loop.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from dataclasses import dataclass
from typing import Protocol

from . import proofpng
from .errors import DeskError

#: How much of a gate's console output is kept, in bytes. A failing render
#: names every layout problem it found and a failing validate names every field
#: over budget; both can run to hundreds of kilobytes. Sixty-four is more than
#: a person reads and enough for an agent to act on, and it is a per-draft cost
#: against a limit of eight open drafts.
MAX_GATE_OUTPUT = 64 * 1024

#: What goes between the head and the tail when output is cut. It names the
#: original size rather than the elided count, because the elided count
#: depends on the length of this marker and would have to be its own
#: fixed point to be right.
_ELISION = "\n... [cut from {n} bytes] ...\n"


@dataclass(frozen=True)
class GateResult:
    """What a gate decided, and everything it said while deciding.

    ``sheets`` holds **basenames**, not paths. The proof directory is the
    caller's to name -- it passed it in -- and a container path in a JSON
    response is a disclosure for no benefit.
    """

    ok: bool
    output: str
    sheets: tuple[str, ...] = ()


class Gates(Protocol):
    """Gate 1 and gate 2, as ``editions.py`` sees them."""

    def validate(self, draft_dir: str) -> GateResult:
        """Gate 1: is this a legal edition, within the length budget?"""

    def render(self, draft_dir: str, out_dir: str) -> GateResult:
        """Gate 2: does it typeset? Leaves proof sheets in ``out_dir``."""


class SubprocessGates:
    """The real gates: the repository's own two tools, run as processes.

    ``repo`` is the checkout root -- the directory holding ``tools/``. In the
    container it is where the repository was copied during the image build, and
    the simulator has already been built there, so the first commit of the day
    does not wait on CMake.

    ``timeout`` is generous on purpose. The render gate may have to build the
    simulator before it can run one, which on a cold checkout is minutes; ten
    is long enough that a timeout means something is genuinely stuck rather
    than merely slow.
    """

    def __init__(self, repo: str, timeout: int = 600) -> None:
        self.repo = os.path.abspath(repo)
        self.timeout = timeout

    def validate(self, draft_dir: str) -> GateResult:
        """Run ``mock_news_server.py --validate`` over the draft's payload.

        No ``--tiles`` argument: the validator looks for a ``tiles/`` directory
        beside the payload by default, and that is exactly how a draft is laid
        out. Passing the path explicitly would be a second place for the two
        layouts to drift apart.
        """
        # sys.executable rather than "python3", so the validator runs under the
        # interpreter the desk was started with instead of whichever one comes
        # first on a PATH the container may not control.
        argv = [sys.executable or "python3",
                os.path.join(self.repo, "tools", "mock_news_server.py"),
                "--validate", os.path.join(draft_dir, "news.json")]
        ok, out = self._run(argv)
        return GateResult(ok=ok, output=out)

    def render(self, draft_dir: str, out_dir: str) -> GateResult:
        """Typeset the draft and convert the sheets it produced.

        The conversion runs whether or not the render passed. A failing render
        is exactly the run whose sheets somebody wants to look at -- that is
        why ``render-check.sh`` carries its exit status past its own conversion
        step rather than letting ``set -e`` throw the sheets away.
        """
        argv = [os.path.join(self.repo, "tools", "edition", "render-check.sh"),
                os.path.join(draft_dir, "news.json"), out_dir]
        ok, out = self._run(argv)

        # On macOS render-check.sh found sips and has already done this, so
        # convert_dir finds no BMPs and does nothing. In the container it is
        # the only thing that converts them.
        try:
            proofpng.convert_dir(out_dir)
        except (DeskError, OSError) as e:
            # A sheet that will not convert is worth reporting, but it is not
            # worth discarding the gate's verdict over: the typesetter has
            # already answered the question the gate was asked.
            out = _truncate(f"{out}\nproof conversion failed: {e}")

        return GateResult(ok=ok, output=out, sheets=_sheets(out_dir))

    def _run(self, argv: list[str]) -> tuple[bool, str]:
        """Run ``argv`` to completion, capturing everything it printed.

        stderr is merged into stdout because the two tools interleave them --
        the validator prints warnings to one and problems to the other -- and
        two separately captured streams cannot be put back in order.
        """
        try:
            p = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                shell=False,          # never a shell: this is caller-shaped data
                # The render gate is a shell script that runs cmake, which runs
                # a compiler. Killing the script alone would orphan all of that
                # and leave it building forever on an always-on machine, so the
                # child gets its own process group and the timeout kills the
                # group. This is why the timeout is not simply
                # subprocess.run(timeout=...), which only kills what it started.
                start_new_session=True,
            )
        except OSError as e:
            # A missing tool or a lost execute bit. Same argument as a timeout:
            # report it, do not raise it.
            return False, _truncate(f"could not run {argv[0]}: {e}")

        try:
            out, _ = p.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            # The reason a timeout is a result rather than an exception: the
            # draft and its output survive, and whoever filed it is told the
            # gate did not finish rather than being told nothing at all.
            out = _kill_and_drain(p)
            return False, _truncate(
                f"{argv[0]} did not finish within {self.timeout}s\n{_decode(out)}")

        return p.returncode == 0, _truncate(_decode(out))


class StubGates:
    """Gates that decide in advance, for tests that are about something else.

    ``calls`` records each gate as it is entered, in order, which is how
    ``test_editions.py`` asserts the property that matters most about the
    pipeline: a draft that fails gate 1 never pays for gate 2, so a failing
    validate leaves ``"render"`` out of this list entirely.
    """

    def __init__(self, validate_ok: bool = True, render_ok: bool = True,
                 output: str = "", sheets: tuple[str, ...] = ()) -> None:
        self.validate_ok = validate_ok
        self.render_ok = render_ok
        self.output = output
        self.sheets = sheets
        self.calls: list[str] = []

    def validate(self, draft_dir: str) -> GateResult:
        """Record the call and return the answer this stub was built with."""
        self.calls.append("validate")
        return GateResult(ok=self.validate_ok, output=self.output)

    def render(self, draft_dir: str, out_dir: str) -> GateResult:
        """Record the call and return the answer this stub was built with."""
        self.calls.append("render")
        return GateResult(ok=self.render_ok, output=self.output,
                          sheets=self.sheets)


def _sheets(out_dir: str) -> tuple[str, ...]:
    """The proof sheets in ``out_dir``, by basename, in a stable order.

    Both suffixes are listed because a Mac's ``sips`` and the desk's own
    converter leave PNGs, but a run that failed before conversion may leave
    BMPs -- and an unconverted sheet is still a sheet somebody should see.
    """
    try:
        names = os.listdir(out_dir)
    except OSError:
        return ()
    return tuple(sorted(n for n in names if n.endswith((".png", ".bmp"))))


def _kill_and_drain(p: subprocess.Popen) -> bytes:
    """Kill a timed-out gate, its children too, and take what it printed.

    ``killpg`` rather than ``kill`` because the thing that hangs is not the
    shell script -- it is the compiler three levels below it, and killing only
    the parent leaves that running.

    The second wait is bounded. If the group kill somehow failed, a surviving
    grandchild still holds the write end of the pipe and an unbounded
    ``communicate()`` would block the desk's thread forever -- turning a
    ten-minute timeout into a permanent one, which is the failure this whole
    path exists to avoid.
    """
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except (OSError, AttributeError):
        p.kill()
    try:
        out, _ = p.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        return b""
    return out or b""


def _decode(raw: bytes) -> str:
    """Console bytes as text. Undecodable bytes are replaced, never fatal."""
    return raw.decode("utf-8", errors="replace")


def _truncate(text: str) -> str:
    """Cut ``text`` to :data:`MAX_GATE_OUTPUT`, keeping both ends.

    Head and tail rather than either alone, because the two gates put the news
    in opposite places: the validator's first ``FAIL`` line is the one to act
    on, and ``render-check.sh`` prints its verdict and the paths to the sheets
    last. Cutting from one end would reliably lose one of them.
    """
    raw = text.encode("utf-8", errors="replace")
    if len(raw) <= MAX_GATE_OUTPUT:
        return text

    marker = _ELISION.format(n=len(raw)).encode()
    room = MAX_GATE_OUTPUT - len(marker)
    head, tail = room // 2, room - room // 2
    return _decode(raw[:head] + marker + raw[len(raw) - tail:])
