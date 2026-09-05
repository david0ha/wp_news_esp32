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

The one thing that runs is at the bottom, and it is a printer rather than a
program: ``python3 agent/prompt.py --language-section ko`` writes
:func:`language_section` to stdout so that ``agent/standalone/file-edition.sh``
-- which assembles its own prompt in a shell, with no desk to ask -- can splice
in the same words rather than carry a second copy of them that drifts.
"""

from __future__ import annotations

import argparse
import os
import sys

#: How much of one context file may reach a prompt. Sixty-four kilobytes is far
#: more standing instruction than anybody writes; the cap is here because this
#: is a directory somebody else owns, with no length the worker knows, and a
#: runaway file would be read into memory and then into a model.
MAX_CONTEXT_BYTES = 64 * 1024

#: What counts as context. Prose and data, nothing else -- a directory of notes
#: also holds images, attachments and editor lock files, and none of those are
#: something to put in front of a language model.
CONTEXT_SUFFIXES = (".md", ".json")

#: What to call a language in the one sentence that asks for it. A tag the model
#: has certainly seen reads better spelled out than as two letters, and Korean
#: carries its own name beside the English one because that is the language the
#: instruction is asking for. This is a courtesy and not a gate: an unlisted tag
#: is asked for by its tag rather than refused, so a desk set to a language
#: nobody here anticipated still files a page in it. See
#: :func:`language_section`.
LANGUAGE_NAMES = {"en": "English", "ko": "Korean (한국어)", "ja": "Japanese", "fr": "French",
                  "de": "German", "es": "Spanish"}

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


def language_section(lang: str | None) -> str:
    """What goes between the contract and the operator's context when the desk
    is not set to English. Empty for ``"en"``: today's prompt, byte for byte.

    Args:
        lang: the edition's language -- a BCP-47 primary subtag, the field the
            desk keeps in ``settings.json`` and the payload carries as its
            top-level ``lang``. ``None`` and ``""`` are English, because this
            is read out of a dict the desk filled in and both are shapes a
            missing setting arrives as.

    Returns:
        A section to splice in after the contract, or ``""``.

    **Where this lands is the argument, and it is the same one the contract
    makes.** The section sits above everything the operator wrote, so a house
    style that has been in Korean all along cannot push the instruction off
    the top -- and below the contract, so the length budgets are still read
    first. It names the fields rather than saying "write in Korean", because
    the ones that are *not* copy are the ones a model gets wrong: a ticker is
    not a word, and a translated ``generated_at`` is a payload the parser
    throws away.

    It also does not restate the budget table. The contract's own "The
    language" section carries what the faces can draw and how a syllable is
    counted; two copies of a number is one copy that goes stale.
    """
    if not lang or lang == "en":
        return ""
    name = LANGUAGE_NAMES.get(lang, lang)
    lines = [
        "\n\n---\n\n# The edition's language\n\n",
        f"Write every reader-facing string in {name}: headlines, decks, bodies, kickers, "
        "bylines, captions, briefs, dossier labels and values, statement titles and row "
        "labels, the dateline, the session line and the as-of line. Tickers, exchange codes, "
        f"tile ids and `generated_at` stay as they are. Set `\"lang\": \"{lang}\"` at the top "
        "level of news.json. The contract's section \"The language\" says what the faces can "
        "draw and how the length budget is counted in this language; read it before writing.\n",
    ]
    if lang == "ko":
        # The two Korean specifics that are not in any general instruction: the
        # faces carry the KS X 1001 set and nothing beyond it, and a won sign
        # is a glyph none of them has -- a page that spells it "₩" fails the
        # validator on a character rather than on anything a reader would call
        # an error.
        lines.append(
            "\nUse only KS X 1001 완성형 syllables; write won as 원/억원/조원, never ₩; "
            "a syllable counts as two characters against every budget — use the "
            "Korean column of the table.\n")
    return "".join(lines)


def build_prompt(contract: str, context: list[tuple[str, str]],
                 directives: list[dict], command_text: str,
                 kind: str = "file_edition", lang: str = "en") -> str:
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
        lang: the edition's language, from the desk's settings. ``"en"`` --
            the default, and what an unset or unreadable setting reads as --
            leaves this prompt byte-identical to the one this worker has
            always sent; anything else adds :func:`language_section`.

    Returns:
        The contract first, then the language section when there is one, then
        the operator's files under their own names, then the directives as
        bullets, then today's instruction, then the tail `kind` selects.

    The order is the argument. The contract is first because everything after it
    is somebody's opinion and an opinion must not be able to push the length
    budgets off the top. The language comes straight after it for the same
    reason and one more: it is not an opinion either, it is what the paper is,
    and the operator's own notes are quite likely written in it already. The
    instruction is last because it is the thing being answered, and a model
    reading a long prompt answers the end of it.
    """
    parts = [contract, language_section(lang)]

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


def main(argv: list[str] | None = None) -> int:
    """Print one piece of a prompt, for a caller that is not Python.

    The standalone producer builds its prompt in ``printf``, so the only way it
    can say the same thing about the language as the worker does is to ask this
    module for the words. ``--language-section en`` prints nothing and exits 0,
    which is what makes the shell side a plain substitution with no branch in it.
    """
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--language-section", metavar="TAG",
                    help="print the section for a language tag, and nothing for 'en'")
    args = ap.parse_args(argv)

    if args.language_section is None:
        ap.print_help(sys.stderr)
        return 2
    sys.stdout.write(language_section(args.language_section))
    return 0


if __name__ == "__main__":
    sys.exit(main())
