"""What the model is told: the shipped contract, the operator's own files, today.

The split this module draws is the open-source boundary of the whole project.
``tools/edition/PROMPT.md`` ships in the repository because it is how anybody
writes a producer -- the length budgets, the colour policy, the shape of the
payload. What sits between that contract and the day's instruction is the
operator's: a house style, a rotation, a list of things that must never print.
None of it is in this repository, none of it is named by this module, and the
worker is complete without any of it.

So there are no special cases here. There is no ``standing.md``, no
``watchlist.json``, no blocklist: there is a directory, and whatever flat
``.md`` and ``.json`` files are in it go into the prompt under their own names,
in sorted order. A reader who keeps their notes in Obsidian points
``AGENT_CONTEXT_DIR`` at a folder of it; a reader who keeps them in a git
repository points it there; a reader who keeps none files a perfectly good page
from the contract alone.

Everything here is **pure**: no environment, no sockets, no clock. The path is
an argument, the contract is an argument, and the only I/O is reading the
directory it was handed. That is what lets ``agent/test/test_prompt.py`` assert
the order of the sections and the shape of a truncated file in milliseconds,
without a desk, an API key or a network.
"""

from __future__ import annotations

import os

#: How much of one context file may reach a prompt. Sixty-four kilobytes is far
#: more standing instruction than anybody writes; the cap is here because this
#: is a directory somebody else owns, with no length the worker knows, and a
#: runaway file would be read into memory and then into a model.
MAX_CONTEXT_BYTES = 64 * 1024

#: What counts as context. Prose and data, nothing else -- a directory of notes
#: also holds images, attachments and editor lock files, and none of those are
#: something to put in front of a language model.
CONTEXT_SUFFIXES = (".md", ".json")

#: Appended to the day's prompt, after everything either side supplied. It is
#: the one instruction that is about the *mechanism* rather than the paper: the
#: worker files, the desk publishes, and a producer that tried to do both would
#: be a second copy of the gate that decides.
_TAIL = (
    "\nWrite the edition into $EDITION_DIR: news.json, and tiles/<id>.bin for every\n"
    "picture it names. Write news.json LAST. Do not try to publish it — the desk\n"
    "validates, typesets and publishes; your job ends when the files are on disk.\n"
)

#: The tail for a ``"research"`` command, in place of :data:`_TAIL`. A research
#: instruction never files a page -- ``loop.handle`` never even opens a draft
#: for one -- so telling the model to write ``news.json`` would be asking for
#: a file this loop is not going to look for. ``"file_edition"`` and
#: ``"custom"`` both get the ordinary :data:`_TAIL`: a custom instruction may
#: or may not turn into a page, and what decides that is what actually lands
#: in the workdir, not a prompt that guessed.
_RESEARCH_TAIL = (
    "\nThis is a research instruction, not a filing one: there is no page to typeset\n"
    "today. Write only $EDITION_DIR/notes.md — what you found, every source with its\n"
    "URL, and what you chose not to print and why. Do not write news.json or any tile;\n"
    "this turn ends when notes.md is on disk.\n"
)


def read_context_dir(path: str | None) -> list[tuple[str, str]]:
    """The operator's context files, as ``(name, text)`` in sorted order.

    Args:
        path: ``AGENT_CONTEXT_DIR``, or ``None`` when the reader configured
            none. An empty string means the same thing.

    Returns:
        One pair per flat ``.md`` or ``.json`` file directly in ``path``, sorted
        by name. Subdirectories are not descended -- ``briefs/`` in particular,
        which the worker writes itself and would otherwise read back into a
        prompt that grew by a section a day forever. Text over
        :data:`MAX_CONTEXT_BYTES` is cut there and carries a visible marker
        saying so, because a model given half a file must be able to see that
        it was given half a file.

    **Never raises.** No directory, an unplugged disk, a file that turns
    unreadable between the listing and the open, bytes that are not UTF-8 --
    all of them answer with less context rather than with an exception. A page
    filed without the operator's notes is a worse page; an exception here is no
    page at all, which is the one failure a wall notices.
    """
    if not path:
        return []
    try:
        names = sorted(os.listdir(path))
    except OSError:
        return []

    out: list[tuple[str, str]] = []
    for name in names:
        if not name.endswith(CONTEXT_SUFFIXES):
            continue
        full = os.path.join(path, name)
        try:
            # One byte past the cap, so "exactly at the cap" and "over it" are
            # distinguishable without reading a file of unknown size.
            with open(full, "rb") as f:
                data = f.read(MAX_CONTEXT_BYTES + 1)
        except OSError:
            continue                # a directory, a dangling link, a bad mode
        if len(data) > MAX_CONTEXT_BYTES:
            text = (data[:MAX_CONTEXT_BYTES].decode("utf-8", "replace")
                    + "\n\n<!-- truncated at %d bytes -->\n" % MAX_CONTEXT_BYTES)
        else:
            text = data.decode("utf-8", "replace")
        out.append((name, text))
    return out


def build_prompt(contract: str, context: list[tuple[str, str]],
                 directives: list[dict], command_text: str,
                 kind: str = "file_edition") -> str:
    """Assemble one turn's prompt.

    Args:
        contract: ``tools/edition/PROMPT.md``, read by the caller.
        context: what :func:`read_context_dir` returned.
        directives: the desk's standing instructions, most recent first, each a
            dict with a ``rule``.
        command_text: the instruction the operator queued, passed through
            untouched.
        kind: the command's kind. ``"research"`` gets :data:`_RESEARCH_TAIL`;
            every other value, including the default, gets the ordinary
            :data:`_TAIL` -- this function does not validate `kind` against
            ``store.COMMAND_KINDS``, the same way ``loop.handle`` treats a
            kind it does not recognise as ``"file_edition"`` rather than
            raising over it.

    Returns:
        The contract first, then the operator's files under their own names,
        then the directives as bullets, then today's instruction, then the tail
        `kind` selects.

    The order is the argument. The contract is first because everything after it
    is somebody's opinion and an opinion must not be able to push the length
    budgets off the top. The instruction is last because it is the thing being
    answered, and a model reading a long prompt answers the end of it.
    """
    parts = [contract]

    if context or directives:
        parts.append("\n\n---\n\n# This desk's standing instructions\n")

    for name, text in context:
        parts.append("\n## %s\n\n%s\n" % (name, text))

    if directives:
        parts.append("\n## Standing directives, most recent first\n\n")
        for directive in directives:
            parts.append("- %s\n" % directive.get("rule", ""))

    parts.append("\n---\n\n# Today's instruction\n\n%s\n" % command_text)
    parts.append(_RESEARCH_TAIL if kind == "research" else _TAIL)
    return "".join(parts)


def revision_prompt(report: dict, sheet_paths: list[str]) -> str:
    """Hand back what the gates said, and the sheets themselves.

    Args:
        report: the desk's proof report -- ``validate`` and ``render`` are the
            two gate transcripts, either of which may be absent when clean.
        sheet_paths: where :func:`loop.fetch_sheets` put the proof images.

    An empty gate report is printed as ``(clean)`` rather than as an empty code
    fence, because a blank fence reads as a truncated message and invites the
    model to go looking for what it missed.
    """
    lines = [
        "The desk ran the real typesetter over the edition you just wrote. "
        "Here is what it found.\n",
        "\n## The schema and length check\n\n```\n%s\n```\n" % (report.get("validate") or "(clean)"),
        "\n## Setting the type\n\n```\n%s\n```\n" % (report.get("render") or "(clean)"),
    ]
    if sheet_paths:
        lines.append(
            "\n## The sheets\n\nRead these images and LOOK at them before you change "
            "anything:\n\n")
        for path in sheet_paths:
            lines.append("- %s\n" % path)
        lines.append(
            "\nThe mechanical checks cannot tell you that a column ran short, that a "
            "headline broke on the wrong word, that the page is grey because nothing on "
            "it is set larger than a deck, or that the photograph halftoned to mush. "
            "That is what you are looking for.\n")
    lines.append(
        "\nFix the edition in place — rewrite $EDITION_DIR/news.json and any tile that "
        "needs it. Change as little as will fix it: a body that is too short wants more "
        "copy, not a different story.\n")
    return "".join(lines)


def look_prompt(sheet_paths: list[str]) -> str:
    """Ask for a verdict when the gates passed but nobody has read the page.

    One word on the first line, and it comes before the edits so that the model
    has to commit to a judgement rather than write one to fit what it already
    changed. Nothing on this side parses it: :func:`loop.handle` discards the
    turn's output and takes whatever files are on disk afterwards, which it
    then re-uploads and proofs again.
    """
    return (
        "The edition passed every mechanical check. Now read the sheets and judge them "
        "as paper.\n\n" + "".join("- %s\n" % p for p in sheet_paths) +
        "\nA page can pass every check and still be a bad page: a column that ran short, "
        "a headline that broke on the wrong word, a sheet that is grey because nothing on "
        "it is set larger than a deck, a photograph that halftoned to mush, a number that "
        "disagrees with the bar drawn under it.\n\n"
        "Answer with exactly one word on the first line — FILE or REVISE — and then, if "
        "REVISE, what is wrong and fix it in $EDITION_DIR.\n")
