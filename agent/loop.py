#!/usr/bin/env python3
"""The worker: claim an instruction, file an edition, look at the paper, commit.

This is the half of the system that holds the owner's credentials and reads the
owner's vault, and it is a separate container from the desk for the reason
``agent/standalone/README.md`` gives for splitting the filing job from the serving
job: filing is an event that can fail, serving is a condition that must hold.
A failed filing must not take the served page down with it, because that turns
a stale paper -- which the firmware is designed to survive and badge -- into no
paper at all.

The loop is deliberately dumb. Every decision that could put a wrong page on a
wall belongs to the desk: the desk validates, the desk typesets, the desk
decides when a page may be published. What the worker owns is research and
prose, which is the half a language model is actually for.

The one step worth naming is step 5. The desk owns the only typesetter, so the
worker cannot see its own paper by rendering it -- it asks the desk to proof the
draft and then *fetches the sheets back and looks at them*. That is what makes
"the desk cannot see the paper" false for the first time in this project: a
column that ran short, a headline that broke on the wrong word, a photograph
that halftoned to mush are all things no schema check can find and a reader
notices from across a room.

Standard library only, and it must run on the python3 that ships in
node:22-slim (3.11), so nothing newer than that is used here.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LOG = logging.getLogger("worker")

DESK = os.environ.get("WPNEWS_DESK", "http://desk:8080")
VAULT = os.environ.get("WPNEWS_VAULT", "/vault")
SECRETS = os.environ.get("WPNEWS_SECRETS", "/run/secrets")
REPO = os.environ.get("WPNEWS_REPO", "/repo")
SCRATCH = os.environ.get("WPNEWS_SCRATCH", "/scratch")

#: How long a claim call parks on the desk. The desk caps this at 90; parking is
#: free on both sides and it is the difference between reacting in a second and
#: reacting on a poll interval.
CLAIM_WAIT = 60

#: A model that has been told twice what is wrong and has not fixed it is not
#: going to fix it on the third try; it is going to spend another research
#: budget arriving somewhere adjacent. Two is enough to absorb a miscount and
#: not enough to burn an afternoon.
MAX_REVISIONS = 2

#: `claude --print` researching a company, fetching quotes and writing two pages
#: is minutes, not seconds. Past this something has gone wrong that waiting will
#: not fix.
CLAUDE_TIMEOUT = 45 * 60

#: The same narrow allowlist agent/standalone/file-edition.sh uses, and narrow for
#: the same reason: the desk needs reads and writes, search, the market data
#: MCPs, and exactly one script. It does NOT get render-check.sh -- in this
#: arrangement the desk owns the typesetter and hands the sheets back, so a
#: worker that could typeset locally would be a second copy of the gate that
#: could disagree with the one that decides.
ALLOWED_TOOLS = (
    "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,mcp__claude_ai_Alpaca__*,"
    "mcp__claude_ai_Kis__*,"
    "Bash(python3 {repo}/tools/make_tile.py:*),"
    "Bash(python3 {repo}/tools/mock_news_server.py:*)"
)


class DeskClient:
    """The control plane, over HTTP, with a bearer token."""

    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, body: bytes = None,
                 content_type: str = "application/json", timeout: int = 120):
        req = urllib.request.Request(self.base + path, data=body, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if body is not None:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, raw
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def _json(self, method: str, path: str, doc=None, timeout: int = 120):
        body = json.dumps(doc).encode() if doc is not None else None
        status, raw = self._request(method, path, body, timeout=timeout)
        if status == 204 or not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except ValueError:
            # A control endpoint that answers with something that is not JSON is
            # a bug on the desk, and reporting the bytes is the only way anybody
            # finds out which endpoint did it.
            return status, {"ok": False, "error": "not_json", "detail": raw[:400].decode(
                "utf-8", "replace")}

    # -- the queue --------------------------------------------------------
    def claim(self):
        """Long-poll for one instruction. ``None`` when the wait expired."""
        status, doc = self._json(
            "GET", "/api/commands/next?wait=%d" % CLAIM_WAIT, timeout=CLAIM_WAIT + 30)
        if status == 204 or doc is None:
            return None
        if status != 200:
            raise RuntimeError("claim failed: %s %s" % (status, doc))
        return doc

    def finish(self, cid: str, ok: bool, result: str) -> None:
        verb = "done" if ok else "fail"
        self._json("POST", "/api/commands/%s/%s" % (cid, verb), {"result": result[:4000]})

    # -- drafts -----------------------------------------------------------
    def open_draft(self) -> str:
        status, doc = self._json("POST", "/api/drafts", {})
        if status != 200:
            raise RuntimeError("open draft: %s %s" % (status, doc))
        return doc["draft_id"]

    def put_payload(self, draft: str, data: bytes) -> None:
        status, raw = self._request("PUT", "/api/drafts/%s/news.json" % draft, data)
        if status != 200:
            raise RuntimeError("put payload: %s %s" % (status, raw[:400]))

    def put_tile(self, draft: str, tile_id: str, data: bytes) -> None:
        status, raw = self._request(
            "PUT", "/api/drafts/%s/tiles/%s.bin" % (draft, tile_id), data,
            content_type="application/octet-stream")
        if status != 200:
            raise RuntimeError("put tile %s: %s %s" % (tile_id, status, raw[:400]))

    def proof(self, draft: str):
        status, doc = self._json("POST", "/api/drafts/%s/proof" % draft, {}, timeout=900)
        if status != 200:
            raise RuntimeError("proof: %s %s" % (status, doc))
        return doc

    def commit(self, draft: str):
        status, doc = self._json("POST", "/api/drafts/%s/commit" % draft, {}, timeout=900)
        if status != 200:
            raise RuntimeError("commit: %s %s" % (status, doc))
        return doc

    def fetch_sheet(self, draft: str, name: str) -> bytes:
        status, raw = self._request("GET", "/api/drafts/%s/proof/%s" % (draft, name))
        if status != 200:
            raise RuntimeError("sheet %s: %s" % (name, status))
        return raw

    # -- standing instructions -------------------------------------------
    def directives(self):
        status, doc = self._json("GET", "/api/directives")
        return (doc or {}).get("directives", []) if status == 200 else []


def read_token() -> str:
    """The producer token, from the mounted secrets directory.

    Two shapes are accepted because two things write them: ``agent.env`` is what
    a human edits, ``tokens.json`` is what the desk reads. Neither is ever
    logged, and a missing one is a hard exit rather than a loop that retries
    forever against a 401 -- a worker that cannot authenticate will not start
    being able to.
    """
    env_path = os.path.join(SECRETS, "agent.env")
    if os.path.exists(env_path):
        for line in open(env_path, encoding="utf-8"):
            line = line.strip()
            if line.startswith("WPNEWS_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")

    tokens_path = os.path.join(SECRETS, "tokens.json")
    if os.path.exists(tokens_path):
        with open(tokens_path, encoding="utf-8") as f:
            doc = json.load(f)
        for entry in doc.get("tokens", []):
            if entry.get("scope") == "producer":
                return entry["token"]

    LOG.error("no producer token: put WPNEWS_TOKEN in %s, or a producer entry in %s",
              env_path, tokens_path)
    raise SystemExit(2)


def load_agent_env() -> dict:
    """Everything in ``agent.env`` except the desk token, for the child process.

    ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN has to be one of these.
    Headless Claude Code in a container will not find a desktop login session,
    and discovering that at 06:00 is exactly the silent failure
    ``file-edition.sh`` already guards against by checking PATH first.
    """
    env = {}
    path = os.path.join(SECRETS, "agent.env")
    if not os.path.exists(path):
        return env
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key == "WPNEWS_TOKEN":
            continue
        env[key] = value.strip().strip('"').strip("'")
    return env


def vault_text(name: str) -> str:
    """A vault file, or an empty string when the SSD is not there.

    The worker degrades to the repository's own PROMPT.md rather than refusing
    to run. A page filed without the owner's standing instructions is a worse
    page; no page at all is a blank wall.
    """
    path = os.path.join(VAULT, name)
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def build_prompt(command: dict, directives) -> str:
    """PROMPT.md is the contract; the vault is the voice.

    The split is the whole open-source boundary of this project. PROMPT.md ships
    in the repository because it is how anybody writes a producer. The
    watchlist, the standing instructions and the blocklist do not, because they
    are one person's editorial judgement about their own money.
    """
    with open(os.path.join(REPO, "tools", "edition", "PROMPT.md"), encoding="utf-8") as f:
        contract = f.read()

    parts = [contract, "\n\n---\n\n# This desk's standing instructions\n"]

    standing = vault_text("standing.md")
    if standing.strip():
        parts.append(standing)

    blocklist = vault_text("blocklist.md")
    if blocklist.strip():
        parts.append("\n## Never print these\n\n" + blocklist)

    watchlist = vault_text("watchlist.json")
    if watchlist.strip():
        parts.append("\n## The rotation\n\n```json\n" + watchlist + "\n```\n")

    if directives:
        parts.append("\n## Standing directives, most recent first\n")
        for d in directives:
            parts.append("- %s\n" % d.get("rule", ""))

    parts.append("\n---\n\n# Today's instruction\n\n%s\n" % command.get("text", ""))
    parts.append(
        "\nWrite the edition into $EDITION_DIR: news.json, and tiles/<id>.bin for every\n"
        "picture it names. Write news.json LAST. Do not try to publish it — the desk\n"
        "validates, typesets and publishes; your job ends when the files are on disk.\n")
    return "".join(parts)


def run_claude(prompt: str, workdir: str, extra_env: dict) -> int:
    """One headless turn. Returns the exit status; the transcript goes to the log."""
    env = dict(os.environ)
    env.update(extra_env)
    env["EDITION_DIR"] = workdir

    argv = [
        "claude", "--print",
        "--add-dir", workdir,
        "--allowedTools", ALLOWED_TOOLS.format(repo=REPO),
        prompt + "\n\nThe repository is at %s. The edition directory is %s." % (REPO, workdir),
    ]
    LOG.info("claude: %d characters of prompt, workdir %s", len(prompt), workdir)
    try:
        proc = subprocess.run(argv, cwd=workdir, env=env, timeout=CLAUDE_TIMEOUT,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except subprocess.TimeoutExpired:
        LOG.error("claude timed out after %d s", CLAUDE_TIMEOUT)
        return 124
    except FileNotFoundError:
        LOG.error("the 'claude' CLI is not on PATH inside this container")
        return 127
    sys.stdout.write(proc.stdout.decode("utf-8", "replace"))
    return proc.returncode


def upload(desk: DeskClient, workdir: str) -> str:
    """Open a draft and PUT the payload and every tile beside it."""
    payload_path = os.path.join(workdir, "news.json")
    if not os.path.exists(payload_path):
        raise RuntimeError("no news.json was produced")

    with open(payload_path, "rb") as f:
        payload = f.read()

    draft = desk.open_draft()
    desk.put_payload(draft, payload)

    tiles_dir = os.path.join(workdir, "tiles")
    count = 0
    if os.path.isdir(tiles_dir):
        for name in sorted(os.listdir(tiles_dir)):
            if not name.endswith(".bin"):
                continue
            with open(os.path.join(tiles_dir, name), "rb") as f:
                desk.put_tile(draft, name[:-4], f.read())
            count += 1
    LOG.info("draft %s: %d bytes and %d tile(s)", draft, len(payload), count)
    return draft


def fetch_sheets(desk: DeskClient, draft: str, names, into: str):
    """Bring the proof sheets back so the next turn can look at them."""
    os.makedirs(into, exist_ok=True)
    paths = []
    for name in names:
        try:
            data = desk.fetch_sheet(draft, name)
        except RuntimeError as e:
            LOG.warning("could not fetch %s: %s", name, e)
            continue
        path = os.path.join(into, name)
        with open(path, "wb") as f:
            f.write(data)
        paths.append(path)
    return paths


def revision_prompt(report: dict, sheet_paths) -> str:
    """Hand back what the gates said, and the sheets themselves."""
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
        for p in sheet_paths:
            lines.append("- %s\n" % p)
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


def look_prompt(sheet_paths) -> str:
    """Ask for a verdict when the gates passed but nobody has read the page."""
    return (
        "The edition passed every mechanical check. Now read the sheets and judge them "
        "as paper.\n\n" + "".join("- %s\n" % p for p in sheet_paths) +
        "\nA page can pass every check and still be a bad page: a column that ran short, "
        "a headline that broke on the wrong word, a sheet that is grey because nothing on "
        "it is set larger than a deck, a photograph that halftoned to mush, a number that "
        "disagrees with the bar drawn under it.\n\n"
        "Answer with exactly one word on the first line — FILE or REVISE — and then, if "
        "REVISE, what is wrong and fix it in $EDITION_DIR.\n")


def write_brief(day: str, command: dict, result: dict, note: str) -> None:
    """Leave a note in the vault saying what was filed and why.

    The vault becomes the desk's memory this way: the next run reads the last
    few briefs, so "you covered this company on Tuesday" is a thing the worker
    knows rather than a thing it re-derives.
    """
    briefs = os.path.join(VAULT, "briefs")
    try:
        os.makedirs(briefs, exist_ok=True)
        path = os.path.join(briefs, day + ".md")
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n## %s — %s\n\n" % (time.strftime("%H:%M"), command.get("kind", "?")))
            f.write("**Instruction:** %s\n\n" % command.get("text", "")[:1000])
            f.write("**Result:** %s (%s)\n\n" % (result.get("state", "?"),
                                                 result.get("edition_id", "-")))
            if note:
                f.write(note.strip()[:4000] + "\n")
    except OSError as e:
        # The SSD is not there. That is not a reason to fail a filing that
        # already reached the glass.
        LOG.warning("could not write the brief: %s", e)


def handle(desk: DeskClient, command: dict, agent_env: dict) -> None:
    """One instruction, from claim to commit."""
    cid = command["id"]
    workdir = os.path.join(SCRATCH, cid)
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(os.path.join(workdir, "tiles"), exist_ok=True)

    prompt = build_prompt(command, desk.directives())
    status = run_claude(prompt, workdir, agent_env)
    if status != 0:
        desk.finish(cid, False, "claude exited %d" % status)
        return

    draft = upload(desk, workdir)
    report = desk.proof(draft)
    sheets = fetch_sheets(desk, draft, report.get("sheets", []),
                          os.path.join(workdir, "proof"))

    revisions = 0
    while not report.get("ok") and revisions < MAX_REVISIONS:
        revisions += 1
        LOG.info("proof failed, revision %d of %d", revisions, MAX_REVISIONS)
        status = run_claude(revision_prompt(report, sheets), workdir, agent_env)
        if status != 0:
            desk.finish(cid, False, "revision %d: claude exited %d" % (revisions, status))
            return
        draft = upload(desk, workdir)
        report = desk.proof(draft)
        sheets = fetch_sheets(desk, draft, report.get("sheets", []),
                              os.path.join(workdir, "proof"))

    if not report.get("ok"):
        desk.finish(cid, False, "the edition does not typeset after %d revisions:\n%s\n%s"
                    % (revisions, report.get("validate", ""), report.get("render", "")))
        return

    # The gates passed. Nobody has read the page yet, and that is the failure
    # this whole arrangement exists to catch.
    if sheets and revisions < MAX_REVISIONS:
        run_claude(look_prompt(sheets), workdir, agent_env)
        # A revision may have rewritten the files; re-upload and re-proof so the
        # thing committed is the thing that was judged.
        draft = upload(desk, workdir)
        report = desk.proof(draft)
        if not report.get("ok"):
            desk.finish(cid, False, "the revision after looking at the sheets does not "
                                    "typeset:\n%s" % report.get("render", ""))
            return

    result = desk.commit(draft)
    LOG.info("committed %s: %s", result.get("edition_id"), result.get("state"))
    write_brief(time.strftime("%Y-%m-%d"), command, result, report.get("validate", ""))
    desk.finish(cid, True, "%s %s" % (result.get("state"), result.get("edition_id")))


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("WPNEWS_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    desk = DeskClient(DESK, read_token())
    agent_env = load_agent_env()
    if not (agent_env.get("ANTHROPIC_API_KEY") or agent_env.get("CLAUDE_CODE_OAUTH_TOKEN")):
        LOG.warning("neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is in "
                    "%s/agent.env — claude will refuse to start", SECRETS)

    LOG.info("worker up, watching %s", DESK)
    backoff = 1.0
    while True:
        try:
            command = desk.claim()
            backoff = 1.0
        except Exception as e:                          # noqa: BLE001 - see below
            # Any failure to reach the desk is the same failure from here: wait
            # and try again. Distinguishing them would produce three branches
            # that all sleep, and a worker that exits on a restart of the desk
            # is a worker that has to be restarted by hand.
            LOG.warning("claim failed (%s); retrying in %.0fs", e, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
            continue

        if command is None:
            continue

        LOG.info("claimed %s: %s", command["id"], command.get("text", "")[:120])
        try:
            handle(desk, command, agent_env)
        except Exception as e:                          # noqa: BLE001
            LOG.exception("command %s failed", command["id"])
            try:
                desk.finish(command["id"], False, "%s: %s" % (type(e).__name__, e))
            except Exception:                           # noqa: BLE001
                LOG.error("could not report the failure either")


if __name__ == "__main__":
    sys.exit(main() or 0)
