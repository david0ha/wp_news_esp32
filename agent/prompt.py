"""What the model is told: the shipped contract, the operator's own files, today.

The split this module draws is the open-source boundary of the whole project.
``tools/edition/PROMPT.md`` ships in the repository because it is how anybody
writes a producer -- the length budgets, the colour policy, the shape of the
payload. ``CALENDAR.md`` beside it is the same thing for the worker's second
job, the event book, and :func:`contract_name` is the whole of how a run
chooses between them. What sits between that contract and the day's
instruction is the
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

#: The contract a kind of command is written against, by file name inside
#: ``tools/edition/``. Everything not named here takes the newspaper's, which
#: is what ``"file_edition"``, ``"research"`` and ``"custom"`` all are: three
#: ways of being asked about the paper. ``"calendar"`` is the other job
#: entirely -- a book about one person's money rather than a page for anybody
#: -- so it reads the other file. See :func:`contract_name`.
CONTRACT_FILES = {"calendar": "CALENDAR.md"}

#: What every other kind reads.
EDITION_CONTRACT = "PROMPT.md"

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

#: The tail for a ``"calendar"`` command. It says the same thing
#: ``CALENDAR.md`` says at length, at the one place a model reads last, and it
#: says the *refusal* rather than the preference: ``loop.upload_calendar``
#: fails the command over a ``news.json`` rather than uploading it, so a run
#: that writes one has spent a research budget on nothing. That file is served
#: with no authorization at all, and this turn is the one holding the owner's
#: positions -- which is why the structural check exists and why this sentence
#: is not relied on to do the work alone.
_CALENDAR_TAIL = (
    "\nThis is a calendar instruction, not a filing one: there is no page to typeset\n"
    "today and no edition to file. Write only $EDITION_DIR/calendar.json — the event\n"
    "book — and write it LAST and atomically: to calendar.json.tmp, then rename.\n"
    "Do not write news.json and do not write a tile. A calendar run files no edition,\n"
    "and the loop refuses a news.json rather than uploading one, so a turn that\n"
    "writes one fails having done the work twice.\n"
)

#: The section an ``"ask"`` gets, between the standing instructions and the
#: message. ``%s`` is the fallback clause, empty when the phone sent no
#: language -- see :func:`ask_section`.
#:
#: It opens by contradicting the contract above it, which is deliberate and is
#: the reason it exists at all: ``PROMPT.md`` is written as "you are filing an
#: edition today", and most messages file nothing. Saying so once, plainly, in
#: the place the model reads it is cheaper than hoping the contract's own
#: hedges carry.
_ASK_SECTION = (
    "\n\n---\n\n# You are answering a message, not filing an edition\n\n"
    "The contract above describes filing an edition. Today that is something you MAY\n"
    "do, not something you are doing. What is in the edition directory:\n\n"
    "- `current/news.json` — the edition the desk is serving now, and `current/tiles/`,\n"
    "  the pictures it names. This is the paper the message is about; read it first.\n"
    "- `previous.md` — the turn before this one, when the message is a follow-up.\n\n"
    "Three rules, in order:\n\n"
    "1. Answer the message in the language it was written in%s. Write the answer to\n"
    "   `answer.md`. It is the whole reply; keep it to what was asked.\n"
    "2. Decide whether the message asks for the paper to change. Questions, opinions,\n"
    "   \"why did it move\", \"what is EPS\" do not. \"Change\", \"add\", \"lead with\",\n"
    "   \"drop\", \"replace the photo\", and the Korean equivalents do.\n"
    "3. Only if it does: copy `current/news.json` to `news.json`, re-research what the\n"
    "   change needs, rewrite the affected parts under the same contract and budgets,\n"
    "   produce any new tiles, and say in `answer.md` what changed and why in two or\n"
    "   three sentences. Do not touch parts the message did not ask about. Do not write\n"
    "   `news.json` for an answer-only message.\n"
)

#: The tail for an ``"ask"``. Two files with two different conditions on them,
#: said at the one place a model reads last. ``answer.md`` is unconditional
#: because ``loop.handle`` fails the command without one, and ``news.json`` is
#: conditional because writing one *is* the decision rule 2 asked for -- the
#: loop does not second-guess it and reads the disk.
_ASK_TAIL = (
    "\nWrite $EDITION_DIR/answer.md — always, whatever else you do; a turn that ends\n"
    "with no answer.md has failed. Write news.json and tiles/<id>.bin ONLY if rule 2\n"
    "said the message asks for the paper to change, and then write news.json LAST. Do\n"
    "not try to publish it — the desk validates, typesets and publishes; your job ends\n"
    "when the files are on disk.\n"
)

#: Which tail each kind ends on. The default is the filing one, and it is the
#: default for the reason ``build_prompt`` gives: a ``custom`` instruction may
#: or may not turn into a page, and what decides that is what lands in the
#: workdir rather than a prompt that guessed.
_TAILS = {"research": _RESEARCH_TAIL, "calendar": _CALENDAR_TAIL, "ask": _ASK_TAIL}


def contract_name(kind: str) -> str:
    """The file in ``tools/edition/`` this kind of command is written against.

    Args:
        kind: the command's kind. Anything not in :data:`CONTRACT_FILES` --
            including a kind this module has never heard of -- gets
            :data:`EDITION_CONTRACT`, the same way :func:`build_prompt` hands
            an unrecognised kind the ordinary filing tail rather than raising
            over it.

    Pure, and a name rather than a path: :func:`loop.read_contract` owns the
    repository root and the I/O, this module owns which of the two documents
    is the contract. That split is what lets the choice be asserted without a
    checkout.
    """
    return CONTRACT_FILES.get(kind, EDITION_CONTRACT)


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


def language_section(lang: str | None, kind: str = "file_edition") -> str:
    """What goes between the contract and the operator's context when the desk
    is not set to English. Empty for ``"en"``: today's prompt, byte for byte.

    Args:
        lang: the edition's language -- a BCP-47 primary subtag, the field the
            desk keeps in ``settings.json`` and the payload carries as its
            top-level ``lang``. ``None`` and ``""`` are English, because this
            is read out of a dict the desk filled in and both are shapes a
            missing setting arrives as.
        kind: the command's kind. ``"calendar"`` gets
            :func:`_calendar_language_section`; everything else gets the
            edition's, including the default -- so the standalone producer's
            ``--language-section ko``, which names no kind, prints exactly
            what it has always printed.

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
    if kind == "calendar":
        return _calendar_language_section(lang, name)
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


def _calendar_language_section(lang: str, name: str) -> str:
    """The same instruction for the other job, whose fields are not a page's.

    This exists because the edition's section above is wrong here in both
    halves, and wrong in the expensive direction each time.

    It names the newspaper's fields and tells the model to set ``lang`` at the
    top of **news.json** -- the one file a calendar run may not write at all.
    A prompt that asks for a file the loop then refuses is a research budget
    spent twice.

    And its Korean addendum carries ``PROMPT.md``'s arithmetic, where a
    syllable counts two because the paper prints on a fixed measure. The phone
    reflows and :mod:`claudepost.calendar` counts code points, so carrying that
    over costs half of every field for nothing -- a 90-character
    ``reason_short`` written as though it were 45. Saying so plainly is
    cheaper than hoping the model reads the brief's own note first, because
    the model that gets this wrong is precisely the one that has read
    ``PROMPT.md`` before.
    """
    return "".join([
        "\n\n---\n\n# The book's language\n\n",
        f"Write every string a person reads in {name}: each event's `title`, every "
        "`reason_short` and `reason`, every `push.title` and `push.body`, and the "
        "`shortfall` sentence. Tickers, position ids, event ids, `source` URLs and "
        f"every instant stay as they are. Set `\"lang\": \"{lang}\"` at the top level "
        "of calendar.json.\n",
        "\nThe brief's section \"The budget the desk enforces\" is in **characters, "
        "not the paper's measure**: 한 글자 counts one here. If you have read "
        "PROMPT.md, do not carry its arithmetic over — it would cost you half of "
        "every field for nothing.\n",
    ])


def ask_section(ask_lang: str | None = None) -> str:
    """The three rules an ``"ask"`` is answered under.

    Args:
        ask_lang: the language the phone was in when the message was typed, or
            ``None``. It is a **fallback**, not an instruction: rule 1 is "the
            language it was written in", and this only decides a message that
            says nothing either way -- a ticker alone, a number. An unlisted tag
            is named by its tag, the way :func:`language_section` does it.

    Pure, and separate from :func:`language_section` because they are two
    different settings that a reader will otherwise conflate. ``lang`` is the
    *paper's* language and comes from the desk's settings; this is the
    *conversation's* and comes from the command. A revision does not change the
    edition's language because the message happened to be typed in English.
    """
    fallback = ""
    if ask_lang:
        fallback = (" (fall back to %s when the message is ambiguous — a ticker "
                    "alone, a number)" % LANGUAGE_NAMES.get(ask_lang, ask_lang))
    return _ASK_SECTION % fallback


def build_prompt(contract: str, context: list[tuple[str, str]],
                 directives: list[dict], command_text: str,
                 kind: str = "file_edition", lang: str = "en",
                 ask_lang: str | None = None) -> str:
    """Assemble one turn's prompt.

    Args:
        contract: ``tools/edition/PROMPT.md``, read by the caller.
        context: what :func:`read_context_dir` returned.
        directives: the desk's standing instructions, most recent first, each a
            dict with a ``rule``.
        command_text: the instruction the operator queued, passed through
            untouched.
        kind: the command's kind. ``"research"`` gets :data:`_RESEARCH_TAIL`,
            ``"calendar"`` gets :data:`_CALENDAR_TAIL` and ``"ask"`` gets
            :data:`_ASK_TAIL`, preceded by :func:`ask_section`; every other
            value, including the default, gets the ordinary :data:`_TAIL` --
            this function does not validate `kind` against
            ``store.COMMAND_KINDS``, the same way ``loop.handle`` treats a
            kind it does not recognise as ``"file_edition"`` rather than
            raising over it. It also selects which language section is
            spliced in, because the book's reader-facing fields are not a
            page's.
        lang: the edition's language, from the desk's settings. ``"en"`` --
            the default, and what an unset or unreadable setting reads as --
            leaves this prompt byte-identical to the one this worker has
            always sent; anything else adds :func:`language_section`.
        ask_lang: for ``"ask"`` only -- the language the phone was in, passed
            to :func:`ask_section` as a fallback. Ignored by every other kind.
            Two languages rather than one because they are two things: `lang`
            is what the paper is written in, this is what the conversation is
            in, and a message typed in English about a Korean paper must not
            turn the paper into an English one.

    Returns:
        The contract first, then the language section when there is one, then
        the operator's files under their own names, then the directives as
        bullets, then the ask section for an ``"ask"``, then today's
        instruction, then the tail `kind` selects.

    The order is the argument. The contract is first because everything after it
    is somebody's opinion and an opinion must not be able to push the length
    budgets off the top. The language comes straight after it for the same
    reason and one more: it is not an opinion either, it is what the paper is,
    and the operator's own notes are quite likely written in it already. The
    instruction is last because it is the thing being answered, and a model
    reading a long prompt answers the end of it.
    """
    parts = [contract, language_section(lang, kind)]

    if context or directives:
        parts.append("\n\n---\n\n# This desk's standing instructions\n")

    for name, text in context:
        parts.append("\n## %s\n\n%s\n" % (name, text))

    if directives:
        parts.append("\n## Standing directives, most recent first\n\n")
        for directive in directives:
            parts.append("- %s\n" % directive.get("rule", ""))

    if kind == "ask":
        parts.append(ask_section(ask_lang))

    parts.append("\n---\n\n# Today's instruction\n\n%s\n" % command_text)
    parts.append(_TAILS.get(kind, _TAIL))
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
