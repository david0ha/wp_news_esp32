# Ask the desk — the wall and the worker: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the whole worker into a container where every `claude` turn runs
as a second, unprivileged user that holds no desk credential, and teach that
worker a fourth command kind — `ask` — that answers a message from the phone and,
when the message asks for it, rewrites the edition it is about.

**Architecture:** The loop keeps its shape: claim, seed a workdir, one headless
turn, then either a note or the draft→proof→revise→look→commit pipeline. Three
things change. The container's process tree becomes two identities — the loop as
root, every `claude` child as `model` via `gosu` — so the model cannot read the
loop's environment. The credentials stop being a file inside the container
altogether and arrive as the loop's environment from the host, because a
bind-mounted file's permissions are **not enforced** on Docker Desktop for Mac
(measured; see Global Constraints). And `handle()` gains an `ask` branch whose
outcome is decided by what the turn left on disk, exactly as `custom`'s is.

**Tech Stack:** Python 3.11 stdlib only (no third-party imports in `agent/`),
`unittest` on `python3 -m unittest discover`, Docker + compose v2, Debian
bookworm (`node:22-slim`), `gosu`, Pillow from `python3-pil`, POSIX `sh` for the
install and image scripts.

**Spec:** [docs/superpowers/specs/2026-09-10-ask-the-desk-design.md](../specs/2026-09-10-ask-the-desk-design.md)
— this plan owns **section 1 (the wall)**, **section 3 (the worker)** and the
agent and image rows of **section 5**. Sections 2 (desk) and 4 (app) are planned
separately; the wire between them is fixed and restated under Global
Constraints.

## Global Constraints

- **The wire this plan codes against, and does not change.** The desk offers
  `GET /api/commands/<cid>` (producer scope) returning the command row including
  `reply_to`, `lang` and `has_notes`; `GET /api/commands/<cid>/notes.md` already
  exists; the command kind is `ask`; the `result` string is one of `answered`,
  `revised <edition_id>`, `staged <edition_id>`, or on failure the worker's own
  message. Someone else is building the first of those. Every test in this plan
  fakes the desk, so no task here blocks on it.
- **`DEFAULT_TOOLS` does not change**: `Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(python3 {repo}/tools/make_tile.py:*),Bash(python3 {repo}/tools/mock_news_server.py:*)`.
  `DENY_TOOLS` stays `Task,Agent`. No task in this plan may widen either.
- **Two measured facts about Docker Desktop for Mac** decide the wall's shape.
  Both were probed on this machine against `node:22-slim` + `gosu`, under
  `--security-opt no-new-privileges:true`, which `agent/compose.yaml` already sets:
  1. A process that is **not root cannot use `gosu`**: `gosu root id -u` from uid
     10001 answers `error: failed switching to "root": operation not permitted`.
     `gosu` is not setuid and `no-new-privileges` would defeat it if it were. So
     the loop must be **root** for a `gosu model` child to be possible at all.
     The spec's sentence "`gosu` is what lets `worker` change user without a
     setuid binary" is wrong, and this plan implements the corrected mechanism.
  2. A bind-mounted file reported as `-rw------- 1 0 0` **is readable by an
     unprivileged container user**: `gosu model cat /run/secrets/agent.env`
     printed the token. Bind-mount permissions are not enforced by VirtioFS. So
     the spec's "mode 0640, group worker, `model` is not in that group" is not a
     wall on this machine, and the credentials must not be in the container's
     filesystem at all.
  3. What *is* enforced: `gosu model cat /proc/<loop pid>/environ` answers
     `Permission denied`. That is the property the whole arrangement rests on.
- **`AGENT_RUN_AS` empty means "do not switch user"**, and it is empty on
  `agent/run-host.sh`. Nothing in this plan may change what a host run does.
- **No third-party Python in `agent/`.** `pwd`, `os`, `json`, `re`, `urllib` only.
- **Every task ends green on `sh agent/test/run.sh`**, which must stay layer 0:
  no Docker, no network, no API key. The image check is a separate script.
- Commit subjects follow the repository's own: `feat(agent): …`, `fix(agent): …`,
  `docs(agent): …`, lowercase, evocative, `--` rather than an em dash.

---

## File Structure

**Created:**

- `agent/test/image.sh` — the wall, asserted against a built image rather than
  described in a comment. Skips with exit 0 when Docker is not on `PATH`.
- `agent/install-docker.sh` — build the image, stand the launchd worker down,
  `compose up -d`. The container-side twin of `agent/run-host.sh`.

**Modified:**

- `agent/Dockerfile` — `gosu`, Pillow, a `model` user, and no `USER` line: PID 1
  is root so it can hand a turn to `model`.
- `agent/compose.yaml` — `env_file` instead of the `/run/secrets` bind mount,
  `AGENT_RUN_AS`, a writable `/state` for the rotation.
- `agent/loop.py` — `AGENT_RUN_AS` and the `gosu` prefix; the workdir handover;
  the `ask` kind: seeding, the three outcomes, the answer as the command's note.
- `agent/deskclient.py` — `command()`, `command_notes()`, `fetch_public()`; a
  token read that accepts the environment.
- `agent/prompt.py` — the `ask` section, its tail, and `ask_lang`.
- `agent/run-host.sh` — one line pinning the host's watchlist path, so moving
  the container's default does not move the host's.
- `agent/test/test_loop.py`, `test_deskclient.py`, `test_prompt.py` — the tests.
- `agent/README.md`, `docs/desk-server.md`, `agent/.env.example`, `CLAUDE.md` —
  the documents.

---

### Task 1: The image — two users, `gosu`, and Pillow

The image gains the second identity and the library `tools/make_tile.py` needs,
and gains a test that runs the built image rather than trusting this paragraph.

**Files:**
- Modify: `agent/Dockerfile`
- Create: `agent/test/image.sh`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: an image `claudepost-agent:latest` whose PID 1 is root, which
  carries a user `model` (uid 10001) with a home at `/home/model`, `gosu` on
  `PATH`, and an importable `PIL`. Task 2 spawns `gosu model`; Task 3 relies on
  there being no `/run/secrets` in it.

- [ ] **Step 1: Write the failing test**

Create `agent/test/image.sh`:

```sh
#!/bin/sh
# image.sh -- the wall, asserted against the image instead of described.
#
# This is layer 2, not layer 0: it builds a container image, so it does not
# belong in agent/test/run.sh, which promises to need neither Docker nor a
# network. It skips rather than fails when Docker is absent, so that running it
# is always safe.
#
#   sh agent/test/image.sh
#
# What it checks is the whole of what the container arrangement claims:
#
#   1. the loop's uid is 0 -- not a preference. A process that is not root
#      cannot use gosu (it is not setuid, and compose sets no-new-privileges),
#      so a non-root loop cannot hand a turn to another user at all.
#   2. `gosu model` lands on uid 10001, a different uid from the loop's.
#   3. the model cannot read the loop's environment, which is the only place
#      the desk token exists inside this container.
#   4. no agent.env anywhere in the filesystem -- the credentials arrive as the
#      loop's environment, because a bind-mounted file's mode is NOT enforced
#      on Docker Desktop for Mac. A 0600 file mounted in was read straight out
#      by an unprivileged user when this was measured.
#   5. Pillow imports, because tools/make_tile.py exits without it and the
#      failure lands forty minutes into a filing run.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH='' cd -- "$here/../.." && pwd)
tag=claudepost-agent:test

if ! command -v docker >/dev/null 2>&1; then
    echo "image: docker is not on PATH; skipping"
    exit 0
fi
if ! docker info >/dev/null 2>&1; then
    echo "image: docker is installed but not running; skipping"
    exit 0
fi

echo "image: building $tag from $repo"
docker build -q -f "$repo/agent/Dockerfile" -t "$tag" "$repo" >/dev/null

run() { docker run --rm --security-opt no-new-privileges:true "$tag" sh -c "$1"; }

fail=0
note() { echo "FAIL: $1"; fail=1; }

loop_uid=$(run 'id -u')
[ "$loop_uid" = "0" ] || note "the loop runs as uid $loop_uid; it must be 0, because a
  process that is not root cannot gosu to the model user at all"

model_uid=$(run 'gosu model id -u')
[ "$model_uid" = "10001" ] || note "gosu model is uid $model_uid, expected 10001"
[ "$model_uid" != "$loop_uid" ] || note "the model runs as the loop's own uid"

run 'python3 -c "import PIL"' >/dev/null 2>&1 \
    || note "Pillow is not importable; tools/make_tile.py would refuse and the paper
  would come out without photographs"

if run 'test -e /run/secrets/agent.env'; then
    note "there is an agent.env in the image; the credentials are supposed to arrive
  as the loop's environment, because a bind mount's mode is not enforced here"
fi

# The one property that IS enforced by the kernel rather than by a mount option.
if docker run --rm --security-opt no-new-privileges:true \
        -e CLAUDEPOST_TOKEN=not-a-real-token "$tag" \
        sh -c 'sleep 20 & p=$!; gosu model cat /proc/$p/environ >/dev/null 2>&1; rc=$?;
               kill $p 2>/dev/null; exit $rc'; then
    note "the model read the loop's environment, which is where the desk token is"
fi

if [ "$fail" -ne 0 ]; then
    echo "image: the wall is not what it says it is"
    exit 1
fi
echo "image: ok -- loop uid 0, model uid 10001, no readable secret, Pillow present"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `sh agent/test/image.sh`
Expected: FAIL. Against today's Dockerfile the first check fails —
`the loop runs as uid 10001; it must be 0` — and the `gosu model id -u` line
aborts the script because there is no `gosu` and no `model`.

- [ ] **Step 3: Rewrite `agent/Dockerfile`**

Replace the body below the header comment. Keep the header comment's first
three paragraphs (why the worker is a separate container) verbatim and add the
identity paragraph:

```dockerfile
# Two identities inside this container, and the split is the point.
#
# The loop runs as root and every `claude` turn runs as `model` (uid 10001)
# through gosu. Root is not a preference here, it is the only thing that works:
# gosu is not setuid, agent/compose.yaml sets `no-new-privileges:true`, and a
# process that is not root therefore cannot change uid at all -- measured, not
# assumed. What the split buys is the one thing that IS enforced by the kernel:
# `model` cannot read /proc/<loop>/environ, and the desk's producer token exists
# nowhere else in this container. The old `worker` user is gone rather than
# renamed; there is nothing left for a third identity to be.
FROM node:22-slim

# python3 runs the loop and the two repo tools the prompt names; curl is for a
# human debugging inside the container. gosu is how a turn is handed to `model`.
# python3-pil is Pillow, which tools/make_tile.py imports -- as the Debian
# package rather than through pip, because a Debian python3 refuses to install
# into itself (PEP 668) and this is the trap that bit the host install. git is
# absent deliberately -- the worker has no business pushing anything.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pil gosu curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# The user every `claude` turn runs as. It has a home because the CLI writes
# its own configuration there, and a home owned by somebody else is a turn that
# fails on its first write.
RUN useradd --create-home --uid 10001 --shell /bin/bash model

WORKDIR /repo
COPY tools/ tools/
# The three modules the loop is, and nothing else. Not agent/ wholesale:
# standalone/ is a different program that runs on a Mac with launchd, and test/
# is the harness -- neither belongs in an image whose job is to run one script.
COPY agent/*.py /app/agent/

ENV PYTHONUNBUFFERED=1 \
    CLAUDEPOST_DESK=http://desk:8080 \
    CLAUDEPOST_REPO=/repo \
    CLAUDEPOST_SCRATCH=/scratch \
    AGENT_RUN_AS=model \
    HOME=/root

# /scratch is the loop's, and each command's directory inside it is handed to
# `model` for the length of one turn -- see loop.own_workdir. /state is the
# rotation cursor's, which is a bind mount in compose and an empty directory
# here so that a bare `docker run` still starts.
RUN mkdir -p /scratch /state

CMD ["python3", "/app/agent/loop.py"]
```

- [ ] **Step 4: Run the image test to verify it passes**

Run: `sh agent/test/image.sh`
Expected: `image: ok -- loop uid 0, model uid 10001, no readable secret, Pillow present`

Note the first build pulls `node:22-slim` and installs npm packages; it takes
minutes. Subsequent runs hit the layer cache.

- [ ] **Step 5: Verify layer 0 is untouched**

Run: `sh agent/test/run.sh`
Expected: PASS, unchanged — no test reads the Dockerfile.

- [ ] **Step 6: Commit**

```bash
git add agent/Dockerfile agent/test/image.sh
git commit -m "feat(agent): a second user for the model, and a test that the wall is real"
```

---

### Task 2: The loop hands each turn to another user

`AGENT_RUN_AS` names a user; `claude_argv` prefixes `gosu <user>`; the child's
`HOME` moves with it; the workdir is handed over before the turn.

**Files:**
- Modify: `agent/loop.py`
- Test: `agent/test/test_loop.py`

**Interfaces:**
- Consumes: the `model` user from Task 1.
- Produces: `Settings.run_as: str`; `loop.run_as_home(user: str) -> str`;
  `loop.own_workdir(cfg: Settings, workdir: str) -> None`;
  `claude_argv(cfg, workdir, kind="file_edition") -> list` now starting with
  `["gosu", cfg.run_as, "claude", …]` when `run_as` is set. Task 7 calls
  `own_workdir` once, after seeding.

- [ ] **Step 1: Write the failing tests**

Add to `agent/test/test_loop.py`, after `ArgvTest`:

```python
class RunAsTest(unittest.TestCase):
    """Handing one turn to a second user, which is the whole of the wall.

    The mechanism is not a preference and the tests say so: gosu is not setuid,
    compose sets no-new-privileges, and a process that is not root cannot change
    uid. So the loop is root in the container and every `claude` is `model` --
    and on a host, where AGENT_RUN_AS is unset, nothing switches at all and the
    command line is byte-identical to the one this worker has always run.
    """

    def test_a_host_run_switches_nobody(self):
        cfg = loop.Settings.from_env({})
        self.assertEqual(cfg.run_as, "")
        self.assertEqual(loop.claude_argv(cfg, "/work")[0], "claude")

    def test_the_model_user_is_prefixed_before_the_cli(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model"})
        argv = loop.claude_argv(cfg, "/work")
        self.assertEqual(argv[:3], ["gosu", "model", "claude"])
        # And the allow-list is still last with nothing after its value: gosu
        # must not push the prompt back onto the command line.
        self.assertEqual(argv[-2], "--allowedTools")

    def test_the_child_gets_that_users_home_and_not_the_loops(self):
        # `claude` writes its own configuration into $HOME. Left at the loop's,
        # every turn fails on its first write into a directory it does not own,
        # and the message is about a config file rather than about a uid.
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model"})
        env = loop.child_env(cfg, "/work", {})
        self.assertEqual(env["HOME"], loop.run_as_home("model"))
        self.assertEqual(env["USER"], "model")
        self.assertEqual(env["LOGNAME"], "model")

    def test_an_unset_run_as_leaves_home_alone(self):
        cfg = loop.Settings.from_env({})
        with mock.patch.dict(os.environ, {"HOME": "/home/somebody"}):
            env = loop.child_env(cfg, "/work", {})
        self.assertEqual(env["HOME"], "/home/somebody")

    def test_a_user_this_image_does_not_have_still_yields_a_home(self):
        # Pure, so a test can assert it on a machine with no `model` user.
        self.assertEqual(loop.run_as_home("nobody-here-at-all"),
                         "/home/nobody-here-at-all")


class OwnWorkdirTest(unittest.TestCase):
    """The workdir is the only writable path the model has, so it has to own it.

    Handed over AFTER the seeding and before the turn: the seeded files are
    written by the loop, and `watchlist.json` is one the contract asks the model
    to rewrite in place.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(os.path.join(self.tmp, "tiles"))
        with open(os.path.join(self.tmp, "watchlist.json"), "w") as f:
            f.write("{}")

    def test_nothing_is_chowned_when_nobody_is_being_switched_to(self):
        cfg = loop.Settings.from_env({})
        with mock.patch("os.chown") as chown:
            loop.own_workdir(cfg, self.tmp)
        chown.assert_not_called()

    def test_every_path_in_the_workdir_is_handed_over(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "model"})
        with mock.patch("os.chown") as chown, \
             mock.patch("loop.pwd.getpwnam") as getpwnam:
            getpwnam.return_value = mock.Mock(pw_uid=10001, pw_gid=10001)
            loop.own_workdir(cfg, self.tmp)
        handed = sorted(call.args[0] for call in chown.call_args_list)
        self.assertEqual(handed, sorted([
            self.tmp,
            os.path.join(self.tmp, "tiles"),
            os.path.join(self.tmp, "watchlist.json")]))
        for call in chown.call_args_list:
            self.assertEqual(call.args[1:], (10001, 10001))

    def test_a_user_the_image_does_not_have_fails_the_command_by_name(self):
        cfg = loop.Settings.from_env({"AGENT_RUN_AS": "ghost"})
        with self.assertRaises(RuntimeError) as caught:
            loop.own_workdir(cfg, self.tmp)
        self.assertIn("ghost", str(caught.exception))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh agent/test/run.sh -k RunAsTest -k OwnWorkdirTest`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'run_as'`,
and `module 'loop' has no attribute 'run_as_home'`.

- [ ] **Step 3: Implement**

In `agent/loop.py`, add `import pwd` beside the other stdlib imports. Add the
field to `Settings` (after `log_level`):

```python
    log_level: str
    #: The user every `claude` turn is spawned as, or "" for "do not switch".
    #: Set to `model` by the image; empty under agent/run-host.sh, where the
    #: turn runs as the operator and there is nobody to switch to.
    run_as: str
```

In `Settings.from_env`, after `log_level=...`:

```python
            # Empty means "run the turn as this process's own user", which is
            # what a host run wants and what a container without the second
            # user can do. The image sets it; nothing else does.
            run_as=env.get("AGENT_RUN_AS", "").strip(),
```

Add beside `claude_argv`:

```python
def run_as_home(user: str) -> str:
    """The home directory of the user a turn is handed to.

    ``claude`` writes its own configuration under ``$HOME``, so a child that
    keeps the loop's ``HOME`` fails on its first write into a directory it does
    not own -- with a message about a config file rather than about a uid.

    A user this machine does not have answers ``/home/<user>`` rather than
    raising: this is a pure function so that the argv and env tests can assert
    it anywhere, and the place a missing user is actually caught is
    :func:`own_workdir`, which has to look it up for real.
    """
    try:
        return pwd.getpwnam(user).pw_dir
    except KeyError:
        return os.path.join("/home", user)


def own_workdir(cfg: Settings, workdir: str) -> None:
    """Hand the command's directory to the user the turn will run as.

    Called once, after every seeded file is written and before the first turn.
    After, because the loop writes those files and the contract asks the model
    to rewrite ``watchlist.json`` in place; before, because the turn is what
    needs to write there at all.

    Does nothing when no user is being switched to, which is every host run.

    Raises:
        RuntimeError: ``AGENT_RUN_AS`` names a user this image does not have.
            :func:`main` has already refused to start a loop that is not root,
            so the remaining way to get here is a typo, and a command that fails
            by name beats a turn that runs as the loop with the wall silently
            absent.
    """
    if not cfg.run_as:
        return
    try:
        ent = pwd.getpwnam(cfg.run_as)
    except KeyError:
        raise RuntimeError(
            "AGENT_RUN_AS=%s is not a user in this image; the turn has nobody "
            "to be handed to" % cfg.run_as)
    for root, dirs, files in os.walk(workdir):
        for name in dirs + files:
            os.chown(os.path.join(root, name), ent.pw_uid, ent.pw_gid)
    os.chown(workdir, ent.pw_uid, ent.pw_gid)
```

At the end of `claude_argv`, before `return argv`:

```python
    # gosu rather than a setuid anything, and root rather than a preference:
    # this prefix only works because the loop is uid 0. A process that is not
    # root cannot change uid at all -- gosu is not setuid and compose sets
    # `no-new-privileges:true` -- which is why `main` refuses to start a
    # non-root loop with this set rather than discovering it here, one claim in.
    if cfg.run_as:
        argv = ["gosu", cfg.run_as] + argv
    return argv
```

In `child_env`, immediately before `return env`:

```python
    # The child is about to become somebody else, so its home moves with it.
    # Left at the loop's, `claude` writes its configuration into a directory it
    # does not own and the turn fails on something that reads like a bad
    # install.
    if cfg.run_as:
        env["HOME"] = run_as_home(cfg.run_as)
        env["USER"] = env["LOGNAME"] = cfg.run_as
    return env
```

In `main()`, after `logging.basicConfig(...)`:

```python
    if cfg.run_as and os.geteuid() != 0:
        # Not a warning: a loop that cannot switch user would run the model as
        # itself, with the desk token in its own environment, and file paper
        # perfectly while the wall this setting names was never there.
        LOG.error("AGENT_RUN_AS=%s, but this loop is uid %d rather than root. "
                  "gosu is not setuid and no-new-privileges is set, so only "
                  "root can hand a turn to another user. Unset AGENT_RUN_AS to "
                  "run the model as this user instead.", cfg.run_as, os.geteuid())
        return 2
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh agent/test/run.sh -k RunAsTest -k OwnWorkdirTest`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the whole layer**

Run: `sh agent/test/run.sh`
Expected: PASS. `SettingsTest.test_a_worker_with_no_environment_at_all_gets_the_images_defaults`
still passes — `run_as` defaults to `""` and that test asserts no new field.

- [ ] **Step 6: Commit**

```bash
git add agent/loop.py agent/test/test_loop.py
git commit -m "feat(agent): the turn runs as somebody else, and only root can say so"
```

---

### Task 3: The credentials leave the container's filesystem

A bind-mounted `agent.env` is readable by `model` on Docker Desktop for Mac
whatever its mode says. So it stops being mounted: compose reads it on the host
and hands it to the loop as environment, where the kernel does enforce the
boundary. The rotation cursor gets its own writable mount, which also fixes the
standing bug that a container could never advance it.

**Files:**
- Modify: `agent/deskclient.py`, `agent/loop.py`, `agent/compose.yaml`, `agent/run-host.sh`
- Test: `agent/test/test_deskclient.py`, `agent/test/test_loop.py`

**Interfaces:**
- Consumes: `Settings.run_as` from Task 2 (unchanged here).
- Produces: `read_token(secrets, environ=None)` accepting the environment;
  `Settings.watchlist` defaulting to `/state/watchlist.json`. Nothing later
  depends on either.

- [ ] **Step 1: Write the failing tests**

In `agent/test/test_deskclient.py`, add to `SecretsTest`:

```python
    def test_the_token_can_arrive_as_the_environment(self):
        # The container arrangement: ~/.claudepost/agent.env is read by compose
        # ON THE HOST and handed to the loop as environment. It is not mounted,
        # because a bind mount's mode is not enforced on Docker Desktop for Mac
        # -- a 0600 file mounted in was read straight out by an unprivileged
        # user when this was measured. The environment is the one place the
        # kernel does keep another uid out.
        self.assertEqual(
            deskclient.read_token(self.tmp, {"CLAUDEPOST_TOKEN": "from-the-env"}),
            "from-the-env")

    def test_the_environment_wins_over_a_file(self):
        # "What this process was started with" beats "what somebody wrote once",
        # which is agent/run-host.sh's rule for its own .env as well.
        with open(os.path.join(self.tmp, "agent.env"), "w") as f:
            f.write("CLAUDEPOST_TOKEN=from-the-file\n")
        self.assertEqual(
            deskclient.read_token(self.tmp, {"CLAUDEPOST_TOKEN": "from-the-env"}),
            "from-the-env")

    def test_a_host_run_still_reads_the_file(self):
        with open(os.path.join(self.tmp, "agent.env"), "w") as f:
            f.write("CLAUDEPOST_TOKEN=from-the-file\n")
        self.assertEqual(deskclient.read_token(self.tmp, {}), "from-the-file")
```

In `agent/test/test_loop.py`, replace `WatchlistTest.test_the_default_lives_beside_the_token_not_in_the_scratch`
with:

```python
    def test_the_default_is_the_state_mount_and_not_the_secrets_one(self):
        # It used to default beside the token, in /run/secrets -- which is
        # mounted read-only, correctly, because it held one. The consequence was
        # that a container could seed the rotation and never advance it. The
        # secrets are not a mount any more (compose hands them to the loop as
        # environment), so the cursor gets a mount of its own, writable, holding
        # nothing confidential: the watch list is seeded into the workdir in
        # front of the model on purpose.
        self.assertEqual(loop.Settings.from_env({}).watchlist,
                         "/state/watchlist.json")
        self.assertEqual(
            loop.Settings.from_env({"CLAUDEPOST_WATCHLIST": "/tmp/w.json"}).watchlist,
            "/tmp/w.json")
```

And add to `WatchlistTest`, which already has `self.path` (the operator's copy),
`self.work` (the edition directory), and the helpers `settings(**env)`,
`write(doc)`, `write_work(doc)` and `back()`:

```python
    def test_the_file_keeps_its_owner_when_a_root_loop_replaces_it(self):
        # The loop is root inside the container, and this writes into a
        # directory the operator owns on the host. Without this the first
        # rotation advance leaves them a root-owned watchlist.json on any host
        # that maps uids honestly. os.chown is patched rather than called: this
        # test does not run as root either.
        cfg = self.settings()
        self.write({"symbols": ["AAAA"], "last": "AAAA"})
        before = os.stat(self.path)
        self.write_work({"symbols": ["AAAA", "BBBB"], "last": "BBBB"})
        with mock.patch("os.chown") as chown:
            self.assertTrue(loop.persist_watchlist(cfg, self.work))
        chown.assert_called_once()
        self.assertEqual(chown.call_args.args[1:], (before.st_uid, before.st_gid))
        # And the rename still happened: the owner is carried across a replace,
        # not instead of one.
        self.assertEqual(self.back()["last"], "BBBB")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh agent/test/run.sh -k SecretsTest -k WatchlistTest`
Expected: FAIL — `read_token() takes 1 positional argument but 2 were given`,
and the watchlist default is still `/run/secrets/watchlist.json`.

- [ ] **Step 3: Implement**

`agent/deskclient.py` — `read_token` gains the environment, first:

```python
def read_token(secrets: str, environ: Mapping[str, str] | None = None) -> str:
    """The producer token: from the environment, then the mounted directory.

    Args:
        secrets: the directory ``~/.claudepost`` is mounted at, when it is.
        environ: the process environment; ``os.environ`` by default. An
            argument so that a test can state one rather than patch one.

    Three shapes are accepted because three things write them, and the order is
    "what this process was started with" before "what somebody wrote once" --
    which is also ``agent/run-host.sh``'s rule for its own ``.env``.

    The environment is first because it is the container's route and the only
    one that holds. ``agent/compose.yaml`` reads ``~/.claudepost/agent.env`` on
    the HOST, through ``env_file``, and the file is not mounted at all: a
    bind-mounted file's mode is not enforced on Docker Desktop for Mac -- a
    0600 file mounted in was read straight out by an unprivileged container user
    when this was measured -- so ``model`` could open a mounted ``agent.env``
    however it was chmodded. It cannot open ``/proc/<loop>/environ``, because
    that is a different uid and the kernel does enforce that one.

    ``agent.env`` and ``tokens.json`` follow, for a host run where neither is a
    problem: there the turn runs as the operator anyway.

    Neither is ever logged, and a missing token is a hard exit rather than a
    loop that retries forever against a 401.

    Raises:
        SystemExit: with code 2, when there is no producer token to be had.
    """
    env = os.environ if environ is None else environ
    token = env.get("CLAUDEPOST_TOKEN")
    if token:
        return token

    env_path = os.path.join(secrets, "agent.env")
    token = _read_env_file(env_path).get("CLAUDEPOST_TOKEN")
    if token:
        return token

    tokens_path = os.path.join(secrets, "tokens.json")
    if os.path.exists(tokens_path):
        with open(tokens_path, encoding="utf-8") as f:
            doc = json.load(f)
        for entry in doc.get("tokens", []):
            if entry.get("scope") == "producer":
                return entry["token"]

    LOG.error("no producer token: set CLAUDEPOST_TOKEN in this process's "
              "environment (agent/compose.yaml's env_file does it), or put it "
              "in %s, or a producer entry in %s", env_path, tokens_path)
    raise SystemExit(2)
```

Add `from collections.abc import Mapping` to `deskclient.py`'s imports if it is
not already there.

`agent/loop.py` — the watchlist default:

```python
            # /state rather than beside the token: the secrets are not a mount
            # any more, and the rotation needs a writable one. Nothing
            # confidential goes here -- the watch list is seeded into the
            # workdir in front of the model on purpose.
            watchlist=(env.get("CLAUDEPOST_WATCHLIST") or "/state/watchlist.json"),
```

Update the `child_env` warning, which is now the ordinary case rather than an
operator's mistake:

```python
    if env.pop("CLAUDEPOST_TOKEN", None) is not None:
        LOG.debug("the desk token is in this process's environment, which is "
                  "where compose's env_file puts it; keeping it out of the "
                  "child, which has no use for it.")
```

In `persist_watchlist`, between the write and the `os.replace`:

```python
        with open(tmp, "wb") as f:
            f.write(data)
        # The loop is root inside the container and this file is the operator's,
        # on a mount they own. Carry the owner across rather than leaving them a
        # root-owned watch list after the first rotation advance. Best effort:
        # on a host where the loop is not root this is a no-op that raises, and
        # a cursor is not worth failing a filing over.
        try:
            before = os.stat(cfg.watchlist)
            os.chown(tmp, before.st_uid, before.st_gid)
        except OSError:
            pass
        os.replace(tmp, cfg.watchlist)
```

`agent/run-host.sh` — pin the host's own path so the container's default moving
does not move it. After the `CLAUDEPOST_SCRATCH` export:

```sh
# The image now defaults this to /state/watchlist.json, which is a mount that
# exists only in a container. Out here it lives beside the token, where it
# always has.
export CLAUDEPOST_WATCHLIST="${CLAUDEPOST_WATCHLIST:-$CLAUDEPOST_SECRETS/watchlist.json}"
```

`agent/compose.yaml` — replace the `environment:`/`volumes:` blocks' secret and
scratch lines. Keep every existing comment that is still true; add:

```yaml
    environment:
      CLAUDEPOST_DESK: ${CLAUDEPOST_DESK:-http://desk:8080}
      AGENT_CONTEXT_DIR: /context
      AGENT_WRITE_BRIEFS: ${AGENT_WRITE_BRIEFS:-0}
      AGENT_TOOLS: ${AGENT_TOOLS:-}
      AGENT_STRICT_MCP: ${AGENT_STRICT_MCP:-1}
      # The user every `claude` turn is handed to. Empty would run the model as
      # the loop, which is root here -- so this is the wall, and the image sets
      # it too. agent/test/image.sh is where it is checked rather than assumed.
      AGENT_RUN_AS: ${AGENT_RUN_AS:-model}
      CLAUDEPOST_WATCHLIST: /state/watchlist.json
      CLAUDEPOST_LOG_LEVEL: ${CLAUDEPOST_LOG_LEVEL:-INFO}
      TZ: ${TZ:-UTC}

    # The producer token and the Claude credential, read by COMPOSE, ON THE
    # HOST, and handed to the loop as its environment. Not a volume, and the
    # difference is the whole security argument: a bind-mounted file's mode is
    # NOT enforced on Docker Desktop for Mac. A file reported as `-rw------- 0 0`
    # was read straight out by an unprivileged container user when this was
    # measured, so `model` could open a mounted agent.env whatever it was
    # chmodded to. It cannot open /proc/<loop pid>/environ -- different uid, and
    # the kernel does enforce that one.
    env_file:
      - ${HOME}/.claudepost/agent.env

    volumes:
      # Bring your own continuity. Uncomment and set AGENT_CONTEXT_DIR in
      # agent/.env. Read-only, and world-readable on purpose: the prompt is
      # MEANT to read it, and so therefore is the model.
      # - ${AGENT_CONTEXT_DIR}:/context:ro
      #
      # The rotation cursor, and only that. Writable, which the old
      # /run/secrets:ro mount could not be -- so until now a container seeded
      # the watch list and could never advance it. Nothing confidential goes
      # here: this file is copied into the workdir in front of the model every
      # run, by design.
      - ${HOME}/.claudepost/state:/state
      #
      # The workdir for one command: the prompt's output, the tiles, and the
      # proof sheets fetched back to look at. Named rather than a bind mount --
      # it is scratch, it is rebuilt per command, and nobody reads it from the
      # host.
      - claudepost-scratch:/scratch
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh agent/test/run.sh`
Expected: PASS.

- [ ] **Step 5: Verify compose still parses**

Run: `docker compose -f agent/compose.yaml config >/dev/null && echo ok`
Expected: `ok`. If it reports the env file is missing, that is the check
working — create `~/.claudepost/agent.env` (Task 8's installer does it) or run
this step on a machine that has one.

- [ ] **Step 6: Commit**

```bash
git add agent/deskclient.py agent/loop.py agent/compose.yaml agent/run-host.sh \
        agent/test/test_deskclient.py agent/test/test_loop.py
git commit -m "fix(agent): a mounted secret is not a secret on this machine"
```

---

### Task 4: The desk client learns three reads

One command row, one command's notes, and one object off the public plane —
which is the only request this client makes without a bearer token.

**Files:**
- Modify: `agent/deskclient.py`
- Test: `agent/test/test_deskclient.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `DeskClient.command(cid: str) -> dict` — the row; raises on any non-200.
  - `DeskClient.command_notes(cid: str) -> str | None` — the text, `None` on 404.
  - `DeskClient.fetch_public(path: str) -> bytes | None` — bytes, `None` on 404,
    no `Authorization` header. Task 5 calls all three.

- [ ] **Step 1: Write the failing tests**

Add to `agent/test/test_deskclient.py`:

```python
class ThreadReadsTest(unittest.TestCase):
    """The previous turn of a thread: its row and the answer filed against it."""

    def _client(self, *answers):
        opener = StubOpener(*answers)
        return deskclient.DeskClient("http://desk:8080", TOKEN, opener), opener

    def test_a_command_row_comes_back_whole(self):
        row = {"id": CID, "kind": "ask", "text": "why did it move?",
               "reply_to": None, "lang": "ko", "has_notes": True}
        desk, opener = self._client((200, json.dumps(row).encode()))
        self.assertEqual(desk.command(CID), row)
        self.assertEqual(opener.requests[0].full_url,
                         "http://desk:8080/api/commands/" + CID)
        self.assertEqual(opener.requests[0].get_header("Authorization"),
                         "Bearer " + TOKEN)

    def test_a_command_that_is_not_there_is_a_failure_and_not_an_empty_row(self):
        desk, _ = self._client((404, b'{"error":"not_found"}'))
        with self.assertRaises(RuntimeError):
            desk.command(CID)

    def test_an_answer_that_is_not_json_is_still_not_a_row(self):
        # _json turns a proxy's HTML page into an envelope; taking that for a
        # command would put a gateway's error text in front of the model as the
        # previous turn of the conversation.
        desk, _ = self._client((200, b"<html>gateway</html>"))
        with self.assertRaises(RuntimeError):
            desk.command(CID)

    def test_the_notes_of_a_command_come_back_as_text(self):
        desk, opener = self._client((200, "답변입니다\n".encode("utf-8")))
        self.assertEqual(desk.command_notes(CID), "답변입니다\n")
        self.assertEqual(opener.requests[0].full_url,
                         "http://desk:8080/api/commands/%s/notes.md" % CID)

    def test_a_command_carrying_no_notes_is_not_a_failure(self):
        # A first turn that failed before it wrote anything is an ordinary
        # thread, and a follow-up to it is still answerable.
        desk, _ = self._client((404, b""))
        self.assertIsNone(desk.command_notes(CID))


class PublicPlaneTest(unittest.TestCase):
    """The one read this client makes with no token on it.

    /news.json and /tiles/<id>.bin are served to the board with no
    authorization, so asking for them as an authenticated producer would put a
    bearer token on a request that does not need one -- and would hide the day
    the public plane stops being public.
    """

    def _client(self, *answers):
        opener = StubOpener(*answers)
        return deskclient.DeskClient("http://desk:8080", TOKEN, opener), opener

    def test_the_edition_is_fetched_without_a_bearer_token(self):
        desk, opener = self._client((200, b'{"lang":"en"}'))
        self.assertEqual(desk.fetch_public("/news.json"), b'{"lang":"en"}')
        self.assertEqual(opener.requests[0].full_url, "http://desk:8080/news.json")
        self.assertIsNone(opener.requests[0].get_header("Authorization"))

    def test_a_desk_serving_no_edition_yet_is_not_a_failure(self):
        desk, _ = self._client((404, b'{"error":"no edition has been filed yet"}'))
        self.assertIsNone(desk.fetch_public("/news.json"))

    def test_any_other_answer_raises_with_the_token_redacted(self):
        desk, _ = self._client((500, ("boom " + TOKEN).encode()))
        with self.assertRaises(RuntimeError) as caught:
            desk.fetch_public("/news.json")
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_a_path_that_is_not_one_is_refused_before_the_socket(self):
        desk, opener = self._client((200, b""))
        with self.assertRaises(ValueError):
            desk.fetch_public("news.json")
        self.assertEqual(opener.requests, [])
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh agent/test/run.sh -k ThreadReadsTest -k PublicPlaneTest`
Expected: FAIL — `'DeskClient' object has no attribute 'command'`.

- [ ] **Step 3: Implement**

Add to `agent/deskclient.py`, after `finish`:

```python
    def command(self, cid: str) -> dict:
        """One command's row, by its id -- the previous turn of a thread.

        Raises:
            RuntimeError: any answer that is not a row. A 404 raises like the
                rest: a ``reply_to`` the desk has never heard of is not an
                empty conversation, it is a desk and a phone that disagree
                about what a thread is, and the caller decides what that costs.
        """
        status, doc = self._json("GET", "/api/commands/%s" % cid)
        if status != 200:
            raise self._fail("command %s" % cid, status, doc)
        if not isinstance(doc, dict) or "id" not in doc:
            raise self._fail("command %s answered with no row" % cid, status, doc)
        return doc

    def command_notes(self, cid: str) -> str | None:
        """The note filed against a command, or ``None`` when it carries none.

        Returns:
            The text, cut at :data:`MAX_NOTES_BYTES` and decoded with
            ``"ignore"`` for :func:`loop.read_notes`'s reason -- a cut at an
            exact byte count is not guaranteed to land on a character boundary,
            and a visible ``�`` is a worse ending than one missing letter.

            ``None`` for a 404, which is the ordinary state of a command whose
            turn wrote nothing: a thread whose first answer failed is still a
            thread, and a follow-up to it is still answerable.
        """
        status, raw = self._request("GET", "/api/commands/%s/notes.md" % cid)
        if status == 404:
            return None
        if status != 200:
            raise self._fail("notes for %s" % cid, status, raw)
        return raw[:MAX_NOTES_BYTES].decode("utf-8", "ignore")

    # -- the public plane -------------------------------------------------
    def fetch_public(self, path: str) -> bytes | None:
        """One object off the plane the board reads, with **no** bearer token.

        Args:
            path: an absolute path on the desk -- ``/news.json`` or
                ``/tiles/<id>.bin``. Anything not starting with ``/`` is a
                caller's bug and raises before a socket is opened.

        Returns:
            The bytes, or ``None`` for a 404 -- which is a real state and not a
            failure: a desk brought up before its first edition answers exactly
            that, and a tile an edition names may have gone.

        The missing header is the point of this method rather than an
        omission. These two routes are served to the board with no
        authorization at all, so asking for them as a producer would put a
        bearer token on a request that does not need one -- and would hide the
        day the public plane stopped being public behind a token that made it
        work anyway.
        """
        if not path.startswith("/"):
            raise ValueError("a public path starts with '/': %r" % path)
        req = urllib.request.Request(self.base + path, method="GET")
        try:
            with self.opener(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise self._fail("public %s" % path, e.code, e.read())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh agent/test/run.sh -k ThreadReadsTest -k PublicPlaneTest`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/deskclient.py agent/test/test_deskclient.py
git commit -m "feat(agent): read one command, its note, and the paper anybody can read"
```

---

### Task 5: Seeding an `ask`

The message is about the paper, so the paper goes in the directory: the served
edition and the pictures it names, plus one turn of the conversation behind it.

**Files:**
- Modify: `agent/loop.py`
- Test: `agent/test/test_loop.py`

**Interfaces:**
- Consumes: `DeskClient.fetch_public`, `.command`, `.command_notes` (Task 4).
- Produces: `loop.ASK_KIND = "ask"`; `loop.CURRENT_DIR = "current"`;
  `loop.ANSWER_NAME = "answer.md"`; `loop.PREVIOUS_NAME = "previous.md"`;
  `seed_current(desk, workdir) -> bool`;
  `seed_previous(desk, workdir, reply_to) -> bool`;
  `read_answer(workdir) -> str | None`;
  `put_notes_best_effort(desk, text, *, draft=None, command=None) -> None`.
  Task 7 calls all of them.

- [ ] **Step 1: Write the failing tests**

Add to `agent/test/test_loop.py`:

```python
class AskSeedTest(unittest.TestCase):
    """What an `ask` is given: the paper it is about, and the turn before it."""

    EDITION = json.dumps({
        "lang": "en",
        "stories": [{"headline": "A", "photo": {"id": "sndk_fab", "w": 4, "h": 2}},
                    {"headline": "B"}],
        "thumbs": [{"id": "chart_a", "w": 2, "h": 2}],
    }).encode()

    class Desk:
        """Enough of DeskClient for the two seeding calls."""

        def __init__(self, edition=None, tiles=None, row=None, notes=None):
            self.edition = edition
            self.tiles = tiles or {}
            self.row = row
            self.notes = notes
            self.public = []

        def fetch_public(self, path):
            self.public.append(path)
            if path == "/news.json":
                return self.edition
            return self.tiles.get(path)

        def command(self, cid):
            if self.row is None:
                raise RuntimeError("command %s: 404 not found" % cid)
            return self.row

        def command_notes(self, cid):
            return self.notes

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_the_served_edition_and_its_pictures_land_under_current(self):
        desk = self.Desk(self.EDITION,
                         {"/tiles/sndk_fab.bin": b"\x01\x02\x03\x04",
                          "/tiles/chart_a.bin": b"\x05\x06"})
        self.assertTrue(loop.seed_current(desk, self.tmp))

        with open(os.path.join(self.tmp, "current", "news.json"), "rb") as f:
            self.assertEqual(f.read(), self.EDITION)
        tiles = sorted(os.listdir(os.path.join(self.tmp, "current", "tiles")))
        self.assertEqual(tiles, ["chart_a.bin", "sndk_fab.bin"])
        # Both kinds of picture the payload can name: a story's photograph and
        # a thumb. A model asked whether the photo suits the story cannot answer
        # from an id.
        self.assertEqual(sorted(desk.public),
                         ["/news.json", "/tiles/chart_a.bin", "/tiles/sndk_fab.bin"])

    def test_a_desk_with_no_edition_yet_is_not_a_failure(self):
        # "What is EPS" is answerable on a desk that has never filed. What is
        # NOT allowed is inventing a paper, and the prompt's rule 3 is what
        # stops that: a revision copies current/news.json, which is not there.
        desk = self.Desk(None)
        self.assertFalse(loop.seed_current(desk, self.tmp))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "current")))

    def test_a_missing_tile_costs_the_picture_and_not_the_turn(self):
        desk = self.Desk(self.EDITION, {"/tiles/chart_a.bin": b"\x05\x06"})
        self.assertTrue(loop.seed_current(desk, self.tmp))
        self.assertEqual(os.listdir(os.path.join(self.tmp, "current", "tiles")),
                         ["chart_a.bin"])

    def test_an_edition_that_is_not_json_fails_the_command(self):
        desk = self.Desk(b"<html>gateway</html>")
        with self.assertRaises(RuntimeError):
            loop.seed_current(desk, self.tmp)

    def test_a_tile_id_that_is_a_path_is_never_asked_for(self):
        # The id becomes a URL and then a filename. Same argument as
        # fetch_sheets: two containers, one token, and the check belongs where
        # the name is joined.
        bad = json.dumps({"stories": [{"photo": {"id": "../../etc/passwd"}}]}).encode()
        desk = self.Desk(bad)
        self.assertTrue(loop.seed_current(desk, self.tmp))
        self.assertEqual(desk.public, ["/news.json"])
        self.assertEqual(os.listdir(os.path.join(self.tmp, "current", "tiles")), [])

    def test_the_previous_turn_carries_the_question_and_the_answer(self):
        desk = self.Desk(row={"id": "a" * 32, "text": "why did it move?"},
                         notes="Because the guide beat the whisper number.\n")
        self.assertTrue(loop.seed_previous(desk, self.tmp, "a" * 32))
        with open(os.path.join(self.tmp, "previous.md"), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("why did it move?", text)
        self.assertIn("Because the guide beat the whisper number.", text)

    def test_a_previous_turn_that_cannot_be_read_costs_the_thread_not_the_answer(self):
        # An enrichment, not a precondition -- directives' posture rather than
        # positions'. The message itself is still in the prompt, so the worst
        # case is an answer that does not remember, not a command that fails.
        desk = self.Desk(row=None)
        self.assertFalse(loop.seed_previous(desk, self.tmp, "a" * 32))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "previous.md")))

    def test_a_reply_to_that_is_not_an_id_never_becomes_a_url(self):
        desk = self.Desk(row={"id": "x", "text": "t"})
        self.assertFalse(loop.seed_previous(desk, self.tmp, "../../api/positions"))


class ReadAnswerTest(unittest.TestCase):
    """`answer.md` is the reply to a person; `notes.md` is the dossier behind a
    page. An `ask` may write both, which is why they are two files."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_no_answer_file_reads_as_no_answer(self):
        self.assertIsNone(loop.read_answer(self.tmp))

    def test_an_answer_comes_back_whole(self):
        with open(os.path.join(self.tmp, "answer.md"), "w", encoding="utf-8") as f:
            f.write("답변이 여기 있습니다.\n")
        self.assertEqual(loop.read_answer(self.tmp), "답변이 여기 있습니다.\n")

    def test_a_notes_file_is_not_an_answer_and_the_reverse(self):
        with open(os.path.join(self.tmp, "notes.md"), "w", encoding="utf-8") as f:
            f.write("the dossier\n")
        self.assertIsNone(loop.read_answer(self.tmp))
        self.assertEqual(loop.read_notes(self.tmp), "the dossier\n")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh agent/test/run.sh -k AskSeedTest -k ReadAnswerTest`
Expected: FAIL — `module 'loop' has no attribute 'seed_current'`.

- [ ] **Step 3: Implement**

Constants, beside `CALENDAR_KIND` in `agent/loop.py`:

```python
#: The command kind the phone posts: a message about the paper, answered in
#: `answer.md`, which becomes an edition only if the model decided the message
#: asked for one. Like `custom`, the disk decides -- see :func:`handle`.
ASK_KIND = "ask"

#: Where the edition the message is about is put. A directory rather than a
#: bare file because the payload names its pictures by id, and a model asked
#: whether the photograph suits the story cannot answer that from an id.
CURRENT_DIR = "current"

#: The reply to a person. A second file beside ``notes.md`` rather than the same
#: one, because an `ask` that rewrites the paper writes both: the dossier goes
#: on the draft and the answer goes on the command, where the phone reads it.
ANSWER_NAME = "answer.md"

#: One turn of the conversation behind this message. One, not the thread: the
#: desk keeps every turn and the phone shows them, and the prompt gets the one
#: that matters.
PREVIOUS_NAME = "previous.md"

#: ``tiles.TILE_ID_RE`` on the desk's side of the token, which is ``ui_tile.c``'s
#: ``id_ok()`` restated. Checked here because an id off the wire becomes a URL
#: and then a filename -- :func:`fetch_sheets`' argument, on the other document.
TILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,15}\Z")

#: ``app.COMMAND_ID_RE``, for the same reason: ``reply_to`` becomes a URL.
COMMAND_ID_RE = re.compile(r"^[0-9a-f]{8,64}\Z")

#: ``tiles.MAX_PAYLOAD_BYTES`` and ``tiles.MAX_TILE_BYTES``, duplicated for
#: :data:`MAX_POSITIONS_BYTES`'s reason: what these bound is not the socket but
#: what is written into a directory a language model is about to read.
MAX_PUBLIC_PAYLOAD_BYTES = 300 * 1024
MAX_PUBLIC_TILE_BYTES = 960_000
```

Replace `read_notes` with a pair over one reader, and add the note filer:

```python
def _read_workdir_text(workdir: str, name: str) -> str | None:
    """One text file out of the workdir, capped and decoded forgivingly.

    Capped at :data:`deskclient.MAX_NOTES_BYTES`, the same quarter-megabyte the
    desk itself refuses past. The cut is decoded with ``"ignore"`` rather than
    ``"replace"``: a read stopped at an exact byte count is not guaranteed to
    land on a UTF-8 character boundary, and a visible ``�`` at the cut is a
    worse ending than one character silently missing.

    Never raises: a directory that vanished between the write and this read is
    not a reason to lose the payload beside it.
    """
    try:
        with open(os.path.join(workdir, name), "rb") as f:
            data = f.read(MAX_NOTES_BYTES)
    except OSError:
        return None
    return data.decode("utf-8", "ignore")


def read_notes(workdir: str) -> str | None:
    """``workdir/notes.md`` -- the dossier behind whatever else the run wrote.

    Returns:
        The note's text, or ``None`` when there is none. That is the ordinary
        case rather than a failure -- a turn with nothing worth writing down
        left nothing behind, the way an edition with no picture is still a
        normal edition.
    """
    return _read_workdir_text(workdir, "notes.md")


def read_answer(workdir: str) -> str | None:
    """``workdir/answer.md`` -- the reply an `ask` writes to a person.

    Separate from :func:`read_notes` because they are separate documents: a
    message that changes the paper produces a dossier about the page *and* a
    reply about the change, and they go to different places.
    """
    return _read_workdir_text(workdir, ANSWER_NAME)


def put_notes_best_effort(desk: DeskClient, text: str | None, *,
                          draft: str | None = None,
                          command: str | None = None) -> None:
    """File one piece of text as a note, best effort.

    Best effort is the whole of it. A note is evidence about a page, not the
    page: a desk that refused one -- too large, some transient failure -- is not
    a reason to hold back an edition that has already passed every gate that
    matters, nor to report a turn that did the work as failed.

    ``ValueError`` is deliberately not caught: naming both or neither of
    ``draft``/``command`` is a bug in this file, not a desk that said no.
    """
    if not text:
        return
    try:
        desk.put_notes(text, draft=draft, command=command)
    except RuntimeError as e:
        owner = f"draft {draft}" if draft is not None else f"command {command}"
        LOG.warning("could not file notes on %s: %s", owner, e)


def file_notes(desk: DeskClient, workdir: str, *, draft: str | None = None,
               command: str | None = None) -> None:
    """File ``workdir/notes.md`` on a draft or a command, best effort.

    One function rather than the same shape at each of the two places a note is
    filed, because "best effort" is a *policy*, and a policy written down twice
    is one that can be half-changed.
    """
    put_notes_best_effort(desk, read_notes(workdir), draft=draft, command=command)
```

The two seeders, after `seed_econ`:

```python
def _current_tile_ids(doc) -> list[str]:
    """Every tile the served edition can ask for: the photographs and the thumbs.

    The same two places ``tools/mock_news_server.py``'s ``_tile_problems``
    looks, and an id that is not one is dropped here rather than fetched: it
    becomes a URL and then a filename.
    """
    ids = []
    if not isinstance(doc, dict):
        return ids
    for story in doc.get("stories") or []:
        if not isinstance(story, dict):
            continue
        photo = story.get("photo")
        tid = photo.get("id") if isinstance(photo, dict) else None
        if isinstance(tid, str) and TILE_ID_RE.match(tid):
            ids.append(tid)
    for thumb in doc.get("thumbs") or []:
        if not isinstance(thumb, dict):
            continue
        tid = thumb.get("id")
        if isinstance(tid, str) and TILE_ID_RE.match(tid):
            ids.append(tid)
    return sorted(set(ids))


def seed_current(desk: DeskClient, workdir: str) -> bool:
    """Put the edition the desk is serving now in the workdir. **`ask` runs only.**

    Returns:
        True if the paper was written, False when the desk is serving none --
        the documented first run, exactly as a missing watch list is. A message
        is still answerable then ("what is EPS"); what is not possible is a
        revision, because the prompt's rule 3 revises by copying a file that is
        not there.

    Raises:
        RuntimeError: the desk answered with something that is not an edition.
            A precondition rather than an enrichment, and the line is the same
            one :meth:`deskclient.DeskClient.positions` draws: a run that
            rewrote the paper while it could not read the paper would replace a
            good edition with one written from nothing.

    Fetched off the **public** plane, with no token on the request. That is not
    a shortcut around the control plane -- it is the same bytes the board reads,
    which is what the message is about.
    """
    raw = desk.fetch_public("/news.json")
    if raw is None:
        LOG.info("the desk is serving no edition yet; this message is about a "
                 "paper that does not exist")
        return False
    if len(raw) > MAX_PUBLIC_PAYLOAD_BYTES:
        raise RuntimeError("the served edition is %d bytes, past the %d a payload "
                           "may be" % (len(raw), MAX_PUBLIC_PAYLOAD_BYTES))
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise RuntimeError("the desk served an edition that is not JSON: %s" % e)

    into = os.path.join(workdir, CURRENT_DIR)
    os.makedirs(os.path.join(into, "tiles"), exist_ok=True)
    with open(os.path.join(into, "news.json"), "wb") as f:
        f.write(raw)

    kept = 0
    for tid in _current_tile_ids(doc):
        path = "/tiles/%s.bin" % tid
        try:
            data = desk.fetch_public(path)
        except RuntimeError as e:
            LOG.warning("could not fetch %s: %s", path, e)
            continue
        if data is None:
            LOG.warning("the edition names %s and the desk does not hold it", path)
            continue
        if len(data) > MAX_PUBLIC_TILE_BYTES:
            LOG.warning("%s is %d bytes; not seeded", path, len(data))
            continue
        with open(os.path.join(into, "tiles", tid + ".bin"), "wb") as f:
            f.write(data)
        kept += 1

    LOG.info("the current edition: %d bytes and %d tile(s)", len(raw), kept)
    return True


def seed_previous(desk: DeskClient, workdir: str, reply_to: str) -> bool:
    """Put the turn this message answers in the workdir. **`ask` runs only.**

    Returns:
        True if a file was written, False when the earlier turn could not be
        read at all.

    An **enrichment**, not a precondition -- :meth:`deskclient.DeskClient.directives`'
    posture rather than :meth:`positions`'. Losing the earlier turn costs the
    conversation, not the answer: the message itself is still in the prompt, so
    the worst case is a reply that does not remember rather than a command that
    fails.

    One turn back, not the thread. The desk keeps every turn and the phone shows
    them; what the prompt gets is the one that this message is a follow-up to.
    """
    if not isinstance(reply_to, str) or not COMMAND_ID_RE.match(reply_to):
        LOG.warning("not a command id, not fetching a previous turn: %r", reply_to)
        return False
    try:
        row = desk.command(reply_to)
        answer = desk.command_notes(reply_to)
    except RuntimeError as e:
        LOG.warning("could not read the turn before this one (%s); answering "
                    "without it", e)
        return False
    text = "".join([
        "# The turn before this one\n\n",
        "## What was asked\n\n%s\n" % (row.get("text") or "(nothing was recorded)"),
        "\n## What you answered\n\n%s\n" % (answer or "(no answer was filed)"),
    ])
    with open(os.path.join(workdir, PREVIOUS_NAME), "w", encoding="utf-8") as f:
        f.write(text)
    return True
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh agent/test/run.sh -k AskSeedTest -k ReadAnswerTest`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the whole layer**

Run: `sh agent/test/run.sh`
Expected: PASS. `UploadNotesTest` and `HandleResearchTest` still pass —
`file_notes` kept its signature and behaviour.

- [ ] **Step 6: Commit**

```bash
git add agent/loop.py agent/test/test_loop.py
git commit -m "feat(agent): a message arrives with the paper it is about"
```

---

### Task 6: The prompt says what an `ask` is

Three rules, verbatim from the spec, between the standing instructions and the
message — plus a tail that names the two files and a system note that stops
telling an answer-only turn it is filing a newspaper.

**Files:**
- Modify: `agent/prompt.py`, `agent/loop.py`
- Test: `agent/test/test_prompt.py`, `agent/test/test_loop.py`

**Interfaces:**
- Consumes: `loop.ASK_KIND` (Task 5).
- Produces: `prompt.ask_section(ask_lang: str | None = None) -> str`;
  `prompt.build_prompt(contract, context, directives, command_text,
  kind="file_edition", lang="en", ask_lang=None) -> str`;
  `loop.ASK_SYSTEM_NOTE`. Task 7 passes `ask_lang=command.get("lang")`.

- [ ] **Step 1: Write the failing tests**

Add to `agent/test/test_prompt.py`:

```python
class AskSectionTest(unittest.TestCase):
    """The three rules, and where they sit.

    Where matters as much as what. The section is below the contract, so the
    length budgets are read first and a message cannot argue with them; below
    the operator's standing instructions, so a house style still applies; and
    above the message, because the message is the thing being answered and a
    model reading a long prompt answers the end of it.
    """

    CONTRACT = "# The contract\n\n## The language\n\nwrite in the edition's language\n"

    def _prompt(self, text="why did it move?", **kw):
        return prompt.build_prompt(self.CONTRACT, [], [], text, kind="ask", **kw)

    def test_the_three_rules_are_all_there(self):
        out = self._prompt()
        self.assertIn("Write the answer to\n   `answer.md`", out)
        self.assertIn("Decide whether the message asks for the paper to change", out)
        self.assertIn("copy `current/news.json` to `news.json`", out)
        self.assertIn("Do not write\n   `news.json` for an answer-only message.", out)

    def test_the_files_it_was_given_are_named(self):
        out = self._prompt()
        self.assertIn("current/news.json", out)
        self.assertIn("current/tiles/", out)
        self.assertIn("previous.md", out)

    def test_the_order_is_contract_then_rules_then_message(self):
        out = prompt.build_prompt(self.CONTRACT, [("house.md", "keep it dry")],
                                  [{"rule": "never lead on a rumour"}],
                                  "lead with the lawsuit", kind="ask")
        self.assertLess(out.index("# The contract"), out.index("keep it dry"))
        self.assertLess(out.index("keep it dry"), out.index("never lead on a rumour"))
        self.assertLess(out.index("never lead on a rumour"),
                        out.index("answering a message"))
        self.assertLess(out.index("answering a message"),
                        out.index("lead with the lawsuit"))

    def test_the_contract_still_comes_first_and_whole(self):
        # The test the spec asks for by name: the contract's own "## The
        # language" section has to be in there, because rule 3 rewrites under
        # the same budgets as a morning edition.
        self.assertIn("## The language", self._prompt())

    def test_the_phones_language_is_a_fallback_and_not_an_instruction(self):
        # Rule 1 is "the language it was written in". `lang` is what the phone
        # was in, which only decides a message that says nothing either way --
        # a ticker alone, a number.
        out = self._prompt(ask_lang="ko")
        self.assertIn("the language it was written in", out)
        self.assertIn("fall back to Korean (한국어)", out)

    def test_no_phone_language_leaves_the_sentence_alone(self):
        out = self._prompt()
        self.assertIn("Answer the message in the language it was written in.", out)
        self.assertNotIn("fall back to", out)

    def test_the_tail_asks_for_the_answer_always_and_the_page_conditionally(self):
        out = self._prompt()
        self.assertIn("answer.md -- always", out.replace("—", "--"))
        self.assertIn("ONLY if", out)
        self.assertIn("write news.json LAST", out)

    def test_no_other_kind_gets_any_of_this(self):
        for kind in ("file_edition", "research", "custom", "calendar"):
            out = prompt.build_prompt(self.CONTRACT, [], [], "t", kind=kind)
            self.assertNotIn("answer.md", out, kind)
            self.assertNotIn("current/news.json", out, kind)

    def test_an_edition_written_in_korean_still_gets_its_own_section(self):
        # `lang` (the paper's) and `ask_lang` (the phone's) are two settings and
        # a revision uses the first: the paper does not change language because
        # the message was typed in English.
        out = self._prompt(lang="ko", ask_lang="en")
        self.assertIn("# The edition's language", out)
        self.assertIn("Write every reader-facing string in Korean", out)
```

Add to `agent/test/test_loop.py`, inside `ArgvTest`:

```python
    def test_an_answer_only_turn_is_not_told_it_is_filing_a_newspaper(self):
        # The calendar note's argument, on the third job: a turn told "you are
        # filing one newspaper edition" and then handed rules that say most
        # messages file nothing is a nudge toward writing the news.json that
        # rule 2 just refused.
        argv = loop.claude_argv(loop.Settings.from_env({}), "/work", "ask")
        note = argv[argv.index("--append-system-prompt") + 1]
        self.assertIn("answering one message about the newspaper", note)
        self.assertNotIn("filing one newspaper edition", note)
        self.assertIn("Do not\ndispatch subagents", note.replace(" \n", "\n"))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh agent/test/run.sh -k AskSectionTest -k ArgvTest`
Expected: FAIL — `build_prompt() got an unexpected keyword argument 'ask_lang'`.

- [ ] **Step 3: Implement**

In `agent/prompt.py`, beside `_CALENDAR_TAIL`:

```python
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

_TAILS = {"research": _RESEARCH_TAIL, "calendar": _CALENDAR_TAIL, "ask": _ASK_TAIL}
```

Add the function after `_calendar_language_section`:

```python
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
```

Change `build_prompt`'s signature and body:

```python
def build_prompt(contract: str, context: list[tuple[str, str]],
                 directives: list[dict], command_text: str,
                 kind: str = "file_edition", lang: str = "en",
                 ask_lang: str | None = None) -> str:
```

Add to its docstring, under Args:

```
        ask_lang: for ``"ask"`` only -- the language the phone was in, passed
            to :func:`ask_section` as a fallback. Ignored by every other kind.
            Two languages rather than one because they are two things: `lang`
            is what the paper is written in, this is what the conversation is
            in, and a message typed in English about a Korean paper must not
            turn the paper into an English one.
```

and, before the instruction is appended:

```python
    if kind == "ask":
        parts.append(ask_section(ask_lang))

    parts.append("\n---\n\n# Today's instruction\n\n%s\n" % command_text)
```

In `agent/loop.py`, beside `CALENDAR_SYSTEM_NOTE`:

```python
#: The same note for the third job. "Answer" rather than "pages", because a
#: turn told it is filing a newspaper and then handed rules under which most
#: messages file nothing has been nudged toward writing the very ``news.json``
#: rule 2 declined -- the same mistake the calendar note was split out to fix.
ASK_SYSTEM_NOTE = _SOLO_NOTE.format(job="answering one message about the newspaper",
                                    work="answer")


def system_note(kind: str) -> str:
    """Which solo note this run gets. One decision, in one place."""
    if kind == CALENDAR_KIND:
        return CALENDAR_SYSTEM_NOTE
    if kind == ASK_KIND:
        return ASK_SYSTEM_NOTE
    return SYSTEM_NOTE
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh agent/test/run.sh -k AskSectionTest -k ArgvTest`
Expected: PASS.

- [ ] **Step 5: Run the whole layer**

Run: `sh agent/test/run.sh`
Expected: PASS. `StandaloneParityTest` still passes: `SYSTEM_NOTE` did not move.

- [ ] **Step 6: Commit**

```bash
git add agent/prompt.py agent/loop.py agent/test/test_prompt.py agent/test/test_loop.py
git commit -m "feat(agent): three rules for a message about the paper"
```

---

### Task 7: `handle()` answers a message

Three end states, decided by what the turn left on disk. This is the task that
makes the feature exist.

**Files:**
- Modify: `agent/loop.py`
- Test: `agent/test/test_loop.py`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 5 and 6.
- Produces: `handle()` accepting `kind == "ask"` and finishing with `answered`,
  `revised <eid>`, `staged <eid>`, or a failure message. The desk and the app
  read those strings; nothing later in this plan does.

- [ ] **Step 1: Write the failing tests**

Add to `agent/test/test_loop.py`:

```python
class HandleAskTest(unittest.TestCase):
    """`handle()`'s fourth case, and its outcomes are the phone's whole contract.

    Like `custom`, the disk decides: a `news.json` after the turn means the
    model judged that the message asked for the paper to change. Unlike
    `custom`, `answer.md` is required either way -- a turn that answered
    nobody has failed, whatever else it produced.
    """

    class Desk:
        """Enough of DeskClient for an ask, either way it goes."""

        def __init__(self, state="published", edition=b'{"lang":"en"}'):
            self.state = state
            self.edition = edition
            self.notes_calls = []
            self.finished = []
            self.commits = []
            self.payloads = []

        def directives(self):
            return []

        def settings(self):
            return {"lang": "en"}

        def fetch_public(self, path):
            return self.edition if path == "/news.json" else None

        def command(self, cid):
            return {"id": cid, "text": "why did it move?"}

        def command_notes(self, cid):
            return "Because the guide beat the whisper number.\n"

        def open_draft(self):
            return "d" * 32

        def put_payload(self, draft, data):
            self.payloads.append((draft, data))

        def put_tile(self, draft, tile_id, data):
            pass

        def put_notes(self, text, *, draft=None, command=None):
            self.notes_calls.append({"text": text, "draft": draft, "command": command})

        def proof(self, draft):
            return {"ok": True, "sheets": []}

        def commit(self, draft):
            self.commits.append(draft)
            return {"state": self.state, "edition_id": "e" * 32}

        def finish(self, cid, ok, result):
            self.finished.append((cid, ok, result))

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = loop.Settings.from_env({"CLAUDEPOST_SCRATCH": self.tmp})
        self._real_read_contract = loop.read_contract
        loop.read_contract = lambda repo, kind="file_edition": "the contract"
        self.addCleanup(setattr, loop, "read_contract", self._real_read_contract)

    def _patch_run_claude(self, fn):
        real = loop.run_claude
        loop.run_claude = fn
        self.addCleanup(setattr, loop, "run_claude", real)

    def _writes(self, **files):
        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            for name, body in files.items():
                path = os.path.join(workdir, name.replace("__", "."))
                with open(path, "w", encoding="utf-8") as f:
                    f.write(body)
            return 0
        return fake_run_claude

    def test_a_question_is_answered_and_nothing_is_filed(self):
        self._patch_run_claude(self._writes(answer__md="EPS is earnings per share.\n"))
        desk = self.Desk()
        cid = "a" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "ask", "text": "what is EPS?"}, {})

        self.assertEqual(desk.commits, [])
        self.assertEqual(desk.notes_calls, [{"text": "EPS is earnings per share.\n",
                                             "draft": None, "command": cid}])
        self.assertEqual(desk.finished, [(cid, True, "answered")])

    def test_a_message_that_changes_the_paper_files_it_and_says_which(self):
        self._patch_run_claude(self._writes(answer__md="Led with the lawsuit.\n",
                                            news__json="{}"))
        desk = self.Desk(state="published")
        cid = "b" * 32
        loop.handle(self.cfg, desk,
                    {"id": cid, "kind": "ask", "text": "lead with the lawsuit"}, {})

        self.assertEqual(desk.commits, ["d" * 32])
        self.assertEqual(desk.finished, [(cid, True, "revised " + "e" * 32)])
        # The answer is on the COMMAND whatever else happened: that is where
        # the phone reads it, at GET /api/commands/<cid>/notes.md.
        self.assertIn({"text": "Led with the lawsuit.\n", "draft": None, "command": cid},
                      desk.notes_calls)

    def test_an_edit_that_changed_nothing_is_still_an_answer(self):
        self._patch_run_claude(self._writes(answer__md="Nothing needed changing.\n",
                                            news__json="{}"))
        desk = self.Desk(state="unchanged")
        cid = "c" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "ask", "text": "add the CFO quote"}, {})
        self.assertEqual(desk.finished, [(cid, True, "revised " + "e" * 32)])

    def test_a_held_desk_says_staged_so_the_phone_can_offer_to_publish(self):
        self._patch_run_claude(self._writes(answer__md="Rewrote the lead.\n",
                                            news__json="{}"))
        desk = self.Desk(state="staged")
        cid = "d" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "ask", "text": "rewrite the lead"}, {})
        self.assertEqual(desk.finished, [(cid, True, "staged " + "e" * 32)])

    def test_a_turn_that_answered_nobody_failed(self):
        # Even one that wrote a perfectly good page: the message came from a
        # person waiting for a reply, and a paper is not a reply.
        self._patch_run_claude(self._writes(news__json="{}"))
        desk = self.Desk()
        cid = "e" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "ask", "text": "lead with the lawsuit"}, {})
        self.assertEqual(desk.commits, [])
        self.assertEqual(desk.finished, [(cid, False, "no answer written")])

    def test_the_paper_and_the_thread_are_in_the_directory_before_the_turn(self):
        seen = {}

        def fake_run_claude(cfg, text, workdir, extra_env, *_):
            seen["current"] = os.path.exists(os.path.join(workdir, "current", "news.json"))
            seen["previous"] = os.path.exists(os.path.join(workdir, "previous.md"))
            seen["prompt"] = text
            with open(os.path.join(workdir, "answer.md"), "w") as f:
                f.write("ok\n")
            return 0

        self._patch_run_claude(fake_run_claude)
        desk = self.Desk()
        loop.handle(self.cfg, desk,
                    {"id": "f" * 32, "kind": "ask", "text": "and the buyback?",
                     "reply_to": "a" * 32, "lang": "ko"}, {})
        self.assertTrue(seen["current"])
        self.assertTrue(seen["previous"])
        # The phone's language reached the prompt as the fallback it is.
        self.assertIn("fall back to Korean", seen["prompt"])

    def test_a_first_turn_has_no_previous_and_asks_for_none(self):
        asked = []

        class Desk(self.Desk):
            def command(self, cid):
                asked.append(cid)
                return {"id": cid, "text": "t"}

        self._patch_run_claude(self._writes(answer__md="ok\n"))
        desk = Desk()
        loop.handle(self.cfg, desk, {"id": "0" * 32, "kind": "ask", "text": "hello"}, {})
        self.assertEqual(asked, [])

    def test_a_turn_that_exited_nonzero_never_reaches_the_desk(self):
        self._patch_run_claude(lambda *a, **k: 3)
        desk = self.Desk()
        cid = "9" * 32
        loop.handle(self.cfg, desk, {"id": cid, "kind": "ask", "text": "hi"}, {})
        self.assertEqual(desk.notes_calls, [])
        self.assertEqual(desk.finished, [(cid, False, "claude exited 3")])
```

- [ ] **Step 2: Run them to verify they fail**

Run: `sh agent/test/run.sh -k HandleAskTest`
Expected: FAIL — an `ask` falls through to the edition path today, so
`test_a_question_is_answered_and_nothing_is_filed` fails inside `upload()` with
`no news.json was produced`.

- [ ] **Step 3: Implement**

In `agent/loop.py`, add beside the other constants:

```python
#: What a commit's state is called back to the phone. ``unchanged`` is
#: ``revised`` on purpose: the owner asked for a change, the desk decided the
#: result was byte-identical to what was already current, and the honest answer
#: to the person waiting is still "I changed the paper" -- the answer.md says
#: what was done. Anything else is passed through under its own name rather
#: than guessed at.
ASK_STATES = {"published": "revised", "unchanged": "revised", "staged": "staged"}
```

Extend `handle`'s docstring with the fourth bullet:

```
    - ``"ask"`` is a message from the phone, and it decides the way ``custom``
      does -- from the disk. It is seeded with the edition the desk is serving
      and with one turn of the conversation behind it; its ``answer.md`` is
      required whatever else the turn produced, because somebody is waiting for
      a reply and a page is not a reply; and a ``news.json`` beside it means
      the model judged that the message asked for the paper to change. That
      judgement is the model's, per the design, and this loop does not
      second-guess it.
```

At the top of `handle`, after `calendar = kind == CALENDAR_KIND`:

```python
    ask = kind == ASK_KIND
```

After the calendar seeding block, and before the prompt is built:

```python
    if ask:
        # Before the turn, and in this order: the paper the message is about,
        # then the turn it answers. The first is a precondition -- a desk that
        # cannot say what it is serving fails here rather than after a revision
        # written from nothing -- and the second is not.
        seed_current(desk, workdir)
        if command.get("reply_to"):
            seed_previous(desk, workdir, command["reply_to"])
    # Last, after every seeded file is on disk: the model owns this directory
    # for the length of the turn, and one of the files it is handed is a watch
    # list the contract asks it to rewrite in place.
    own_workdir(cfg, workdir)
```

Pass the phone's language into the prompt:

```python
    text = prompt.build_prompt(
        read_contract(cfg.repo, kind),
        prompt.read_context_dir(cfg.context_dir),
        desk.directives(),
        command.get("text", ""),
        kind=kind,
        lang=desk.settings().get("lang", "en"),
        ask_lang=command.get("lang"))
```

After the `calendar` block and before the `custom` one:

```python
    answer = None
    if ask:
        answer = read_answer(workdir)
        if not answer:
            # Whatever else it produced. Somebody is waiting for a reply and a
            # page is not a reply -- and a page filed with no answer beside it
            # would change the paper on the wall with nobody told why.
            desk.finish(cid, False, "no answer written")
            return
        if not os.path.exists(os.path.join(workdir, "news.json")):
            put_notes_best_effort(desk, answer, command=cid)
            desk.finish(cid, True, "answered")
            return
        # Otherwise the message asked for the paper to change, and the rest of
        # this function is exactly the path a morning edition takes: the same
        # five gates, the same two revisions, the same look at the sheets. A
        # revised edition that does not typeset fails the command and leaves
        # the current one standing -- the firmware's own failure semantics.
```

And at the end, replacing the final `desk.finish(...)`:

```python
    result = desk.commit(draft)
    LOG.info("committed %s: %s", result.get("edition_id"), result.get("state"))
    persist_watchlist(cfg, workdir)
    write_brief(cfg, time.strftime("%Y-%m-%d"), command, result,
                report.get("validate", ""))

    if ask:
        # Re-read: the revision and look turns may have rewritten the reply
        # along with the page, and what goes to the person is what the run
        # finished believing rather than its first draft.
        answer = read_answer(workdir) or answer
        # The command, always: that is where the phone reads the answer. And
        # the draft too when the turn left no dossier of its own, so an edition
        # is never filed with nothing beside it saying why it changed.
        put_notes_best_effort(desk, answer, command=cid)
        if not read_notes(workdir):
            put_notes_best_effort(desk, answer, draft=draft)
        state = ASK_STATES.get(result.get("state"), result.get("state") or "revised")
        desk.finish(cid, True, "%s %s" % (state, result.get("edition_id")))
        return

    desk.finish(cid, True, "%s %s" % (result.get("state"), result.get("edition_id")))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh agent/test/run.sh -k HandleAskTest`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify no other kind moved**

Run: `sh agent/test/run.sh`
Expected: PASS — in particular `HandleCustomTest`, `HandleResearchTest`,
`HandleCalendarTest` and `SeedingSplitTest`, which sweep every other kind and
would catch an `ask` branch that leaked into one.

- [ ] **Step 6: Extend the seeding split sweep**

`SeedingSplitTest` runs one command of each kind through `handle()` and asserts
on the directory the model was started in. It sweeps `("file_edition",
"research", "custom")` in two tests and drives everything through
`CalendarDesk`, which is "enough of `DeskClient` for every kind" — so it needs
the public-plane method now, and its `run_seeding` helper needs to know what an
`ask` writes.

In `CalendarDesk`, after the `econ`/`put_calendar` block:

```python
    # the public plane, which only an `ask` reads
    def fetch_public(self, path):
        return b'{"lang": "en"}' if path == "/news.json" else None
```

In `SeedingSplitTest.run_seeding`, extend the two maps:

```python
        deliverable = {"research": "notes.md", "calendar": "calendar.json",
                       "ask": "answer.md"}.get(kind, "news.json")
        contents = {"calendar": '{"events": [], "shortfall": null}',
                    "ask": "answered\n"}.get(kind, "{}")
```

Add `"ask"` to the sweep tuple in both
`test_seed_positions_runs_only_for_the_calendar_kind` and
`test_the_other_two_seeded_files_follow_the_same_split`, so they read
`for kind in ("file_edition", "research", "custom", "ask"):`. That is the
load-bearing edit in this step: `ask` is the second kind that talks to the desk
before the turn, and the owner's positions must not be one of the things it is
handed.

Then add:

```python
    def test_the_paper_is_seeded_for_an_ask_and_for_no_other_kind(self):
        # The mirror of the positions split, and a weaker property on purpose:
        # /news.json is public, so seeding it into a morning run leaks nothing.
        # It is still wrong -- a filing run handed yesterday's paper edits it
        # instead of writing today's -- and an absence has to be looked for
        # everywhere it could be.
        for kind in ("file_edition", "research", "custom", "calendar"):
            with self.subTest(kind=kind):
                workdir = self.run_seeding(kind)
                self.assertFalse(os.path.exists(os.path.join(workdir, "current")))
        workdir = self.run_seeding("ask")
        self.assertTrue(os.path.exists(os.path.join(workdir, "current", "news.json")))
```

Run: `sh agent/test/run.sh -k SeedingSplitTest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/loop.py agent/test/test_loop.py
git commit -m "feat(agent): answer the message, and change the paper only when asked"
```

---

### Task 8: `agent/install-docker.sh`

The container-side twin of `agent/run-host.sh`: build the image from this
checkout, stand the launchd worker down, bring the compose service up. It also
does the one migration this plan creates — the rotation cursor moves into
`~/.claudepost/state/`.

**Files:**
- Create: `agent/install-docker.sh`

**Interfaces:**
- Consumes: the image (Task 1) and the compose file (Task 3).
- Produces: nothing other code reads.

- [ ] **Step 1: Write it**

```sh
#!/usr/bin/env bash
#
# install-docker.sh — move the worker off this machine's launchd and into the
# container, on this machine.
#
#   ./agent/install-docker.sh
#   ./agent/install-docker.sh --keep-launchd     # build and start, stand nothing down
#
# The twin of agent/run-host.sh, and the choice between them is a bill and a
# wall. run-host.sh spends the operator's Claude subscription and runs every
# turn as the operator; this spends a token and runs every turn as `model`, a
# user that cannot read the desk credential. Both claim from the same queue.
#
# Two workers on one queue would race for every command, which is why this
# stands the launchd job down rather than leaving it to be noticed later.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="${CLAUDEPOST_SECRETS:-$HOME/.claudepost}"
LABEL=com.claudepost.worker

die() { echo "install-docker: $1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not on PATH."
docker info >/dev/null 2>&1 || die "docker is installed but not running. Start Docker Desktop."

# 1. The credentials, which compose reads ON THE HOST and hands to the loop as
#    its environment. They are deliberately not mounted -- a bind mount's mode
#    is not enforced on Docker Desktop for Mac, so a mounted agent.env is
#    readable by every user in the container including the one the model runs
#    as. See agent/test/image.sh.
[ -f "$SECRETS/agent.env" ] || die "no $SECRETS/agent.env — mint a producer token first:
  server/tools/mint-token.sh producer agent
  then put CLAUDEPOST_TOKEN=<it> in $SECRETS/agent.env, mode 0600."

grep -qsE '^CLAUDEPOST_TOKEN=.' "$SECRETS/agent.env" \
    || die "$SECRETS/agent.env has no CLAUDEPOST_TOKEN. The worker cannot file without one."

grep -qsE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' "$SECRETS/agent.env" \
    || die "$SECRETS/agent.env has neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY.
  Headless Claude Code in a container finds no desktop login to inherit, so one of
  them has to be there. \`claude setup-token\` mints the first, which spends the
  subscription; the second is metered."

# 2. The rotation cursor, which now has a mount of its own -- writable, where
#    the old secrets mount was read-only and a container could seed the watch
#    list but never advance it.
mkdir -p "$SECRETS/state"
if [ -f "$SECRETS/watchlist.json" ] && [ ! -f "$SECRETS/state/watchlist.json" ]; then
    echo "install-docker: moving watchlist.json into $SECRETS/state/"
    mv "$SECRETS/watchlist.json" "$SECRETS/state/watchlist.json"
fi

# 3. The network, which neither compose file creates because neither owns the
#    other.
docker network inspect claudepost >/dev/null 2>&1 || {
    echo "install-docker: creating the claudepost network"
    docker network create claudepost >/dev/null
}

# 4. The image, from THIS checkout. The build context is the repository root:
#    the image carries tools/ as well as the loop.
echo "install-docker: building claudepost-agent:latest from $REPO"
docker build -f "$REPO/agent/Dockerfile" -t claudepost-agent:latest "$REPO"

# 5. The wall, checked rather than assumed. A worker whose model user can read
#    the loop's environment is a worker with no wall, and finding that out here
#    costs a minute where finding it out later costs the token.
sh "$REPO/agent/test/image.sh"

# 6. Two workers on one queue race for every command.
if [ "${1:-}" != "--keep-launchd" ]; then
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        echo "install-docker: standing the launchd worker down"
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    fi
    if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
        echo "install-docker: NOTE — $HOME/Library/LaunchAgents/$LABEL.plist is still"
        echo "  installed and will start again at your next login. Remove it yourself"
        echo "  when you are sure the container is the arrangement you want:"
        echo "      rm ~/Library/LaunchAgents/$LABEL.plist"
    fi
fi

# 7. Up. --no-build because step 4 already did it, from a context this script
#    named rather than one compose inferred.
echo "install-docker: starting the worker"
docker compose -f "$REPO/agent/compose.yaml" up -d --no-build

echo
echo "install-docker: up. The worker claims from ${CLAUDEPOST_DESK:-http://desk:8080}."
echo "  docker compose -f agent/compose.yaml logs -f"
echo "  docker compose -f agent/compose.yaml down"
```

- [ ] **Step 2: Make it executable and check it parses**

```bash
chmod +x agent/install-docker.sh
bash -n agent/install-docker.sh && echo "parses"
```
Expected: `parses`

- [ ] **Step 3: Run its refusals**

```bash
CLAUDEPOST_SECRETS=/tmp/no-such-dir ./agent/install-docker.sh
```
Expected: exits non-zero with `no /tmp/no-such-dir/agent.env — mint a producer
token first`. It must fail before touching Docker.

- [ ] **Step 4: Commit**

```bash
git add agent/install-docker.sh
git commit -m "feat(agent): one command to move the worker behind the wall"
```

---

### Task 9: The documents

Four files describe the worker, and all four are now wrong in the same three
places: what runs where, what the credentials are, and what a fourth kind does.

**Files:**
- Modify: `agent/README.md`, `docs/desk-server.md`, `agent/.env.example`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above. Produces: nothing code reads.

- [ ] **Step 1: `agent/README.md` — "Running it in a container"**

Replace steps 2 and 3 of that section with:

```markdown
**2. Credentials**, in `~/.claudepost/agent.env`, mode 0600, **outside the
repository** — because the repository is public and git history is permanent:

```sh
ANTHROPIC_API_KEY=sk-ant-...          # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
CLAUDEPOST_TOKEN=<a producer token>   # server/tools/mint-token.sh producer agent
```

That file is **not mounted into the container**. `agent/compose.yaml` reads it
on the host, through `env_file`, and the loop gets it as its environment. The
reason is measured rather than assumed: on Docker Desktop for Mac a
bind-mounted file reported as `-rw------- 0 0` is readable by an unprivileged
container user anyway, so a mounted `agent.env` would be readable by the very
user the model runs as. `/proc/<loop pid>/environ` is not — different uid, and
the kernel enforces that one. `agent/test/image.sh` checks both.

**3. Up.**

```sh
./agent/install-docker.sh       # build, check the wall, stand launchd down, up -d
docker compose -f agent/compose.yaml logs -f
```
```

Then add a new subsection after it:

```markdown
### Two users in one container

The loop runs as **root**; every `claude` turn runs as **`model`** (uid 10001)
through `gosu`, and the workdir is handed to that user for the length of the
turn. Root is not a preference: `gosu` is not setuid, compose sets
`no-new-privileges:true`, and a process that is not root cannot change uid at
all — so a non-root loop could not hand a turn to anybody.

What the split buys is one sentence: **the model cannot read the desk token**,
because the token exists only in the loop's environment and the kernel keeps
another uid out of `/proc/<pid>/environ`. That is stronger than the old
arrangement, where the token was stripped from the child's environment but a
`Bash` tool could in principle have read the parent's.

What it does not buy: the container has ordinary outbound internet, because
`WebSearch` and `WebFetch` are the point. It is not an egress allowlist. The
desk's `/api/*` is reachable from inside and still needs a bearer token; the
public plane (`/news.json`, `/tiles/<id>.bin`) is public by design and is
exactly what an `ask` is seeded from.

`agent/run-host.sh` switches nobody: out there the turn runs as the operator,
which is the same trade that script has always been.
```

- [ ] **Step 2: `agent/README.md` — the fourth kind**

In "What it does with one instruction", after the paragraph about `kind`
deciding where `notes.md` lands, add:

```markdown
A fourth kind, `ask`, is a message from the phone. It is seeded with the
edition the desk is serving now (`current/news.json` and `current/tiles/`,
fetched off the public plane) and, when the message is a follow-up, with the
turn before it (`previous.md`). The turn writes `answer.md` — always; a turn
that answered nobody has failed — and writes `news.json` only if it judged that
the message asked for the paper to change. That judgement is the model's and
this loop does not second-guess it: a `news.json` in the workdir means "revise",
exactly as it does for `custom`.

The answer goes on the command, at `PUT /api/commands/<id>/notes.md`, which is
where the phone reads it. The command's result is `answered`, `revised <edition
id>` or `staged <edition id>` — the first word is what the phone branches on. A
revision that fails a gate fails the command and leaves the current edition
standing, which is the firmware's own failure semantics: a stale paper beats an
empty one.
```

- [ ] **Step 3: `agent/README.md` — the watch list and Verifying**

In "The watch list", note the move:

```markdown
In a container it lives at `/state/watchlist.json`, which is
`~/.claudepost/state/` on the host — a mount of its own, and **writable**,
where the old read-only secrets mount meant a container could seed the rotation
and never advance it. `agent/install-docker.sh` moves an existing
`~/.claudepost/watchlist.json` there for you. Under `agent/run-host.sh` it
stays beside the token, where it always was.
```

In "Verifying", add the image line:

```markdown
```sh
sh agent/test/run.sh        # layer 0: no Docker, no network, no API key
sh agent/test/image.sh      # layer 2: builds the image and checks the wall.
                            # Skips with exit 0 when Docker is not on PATH.
```
```

- [ ] **Step 4: `docs/desk-server.md` — "The worker"**

After the paragraph beginning "**A container or a process on your own machine**",
insert:

```markdown
**In the container there are two users and the split is the credential.** The
loop runs as root and every `claude` turn runs as `model` through `gosu`, in a
workdir handed to that user for the length of the turn. Root is the only thing
that works — `gosu` is not setuid and `no-new-privileges` is set, so a non-root
process cannot change uid — and what it buys is that the desk's producer token
lives only in the loop's environment, which another uid cannot read. The token
is not a file in the container: compose reads `~/.claudepost/agent.env` on the
host and hands it over as environment, because a bind mount's mode is not
enforced on Docker Desktop for Mac. The tool allowlist is unchanged, and the
container has ordinary outbound internet: this is a wall around the
credentials, not an egress allowlist.
```

And extend the `kind` paragraph with the fourth:

```markdown
**`"ask"` is the fourth, and it decides from the disk the way `custom` does.**
A message from the phone, seeded with the edition the desk is serving (off the
public plane, the same bytes the board reads) and one turn of the conversation
behind it. It must write `answer.md`, which is filed on the command and is what
the phone reads back; it writes `news.json` only if it judged that the message
asked for the paper to change, and then the ordinary five gates apply
unchanged. The result reads `answered`, `revised <edition id>` or `staged
<edition id>`. A revision that fails a gate fails the command and the current
edition stays current.
```

- [ ] **Step 5: `agent/.env.example`**

Add, after the `AGENT_STRICT_MCP` block:

```sh
# The user every `claude` turn is handed to inside the container. `model` is
# the image's second user; empty runs the turn as the loop itself, which is
# root in the container -- so leave this alone unless you know why you are
# changing it. agent/run-host.sh ignores it: out there the turn runs as you.
AGENT_RUN_AS=

# Where the rotation cursor lives inside the container. The compose file mounts
# ~/.claudepost/state there. Empty means /state/watchlist.json.
CLAUDEPOST_WATCHLIST=
```

Also correct the file's opening paragraph, which says the credentials are
"mounted read-only" — they are no longer mounted at all:

```sh
# Nothing secret belongs here. The producer token and the API key live in
# ~/.claudepost/agent.env, outside the repository — read by compose ON THE HOST
# and handed to the loop as its environment, never mounted into the container.
# What this file holds is *where things are*, which is personal without being
# confidential.
```

- [ ] **Step 6: `CLAUDE.md` — the verify block**

In "Verify before claiming anything works", add the image check to layer 2,
after `python3 tools/test_calendar_brief.py`:

```sh
# the worker image, when Docker is on this machine: two users, no readable
# secret, Pillow present. Skips with exit 0 when docker is not on PATH.
sh agent/test/image.sh
```

- [ ] **Step 7: Verify the documents against the code**

```bash
grep -n "run_as\|AGENT_RUN_AS" agent/loop.py agent/compose.yaml agent/Dockerfile agent/.env.example
grep -rn "/run/secrets" agent/ docs/desk-server.md
```
Expected: the first prints the setting in all four places. The second prints
only `Settings.from_env`'s default and the comments that explain why nothing is
mounted there — no live mount in `compose.yaml`, and no README step telling
somebody to create one.

- [ ] **Step 8: Run everything one more time**

```bash
sh agent/test/run.sh
sh agent/test/image.sh
sh server/test/run.sh
```
Expected: all three PASS. `server/test/run.sh` is run because
`docs/desk-server.md` changed and the desk's own tests are cheap.

- [ ] **Step 9: Commit**

```bash
git add agent/README.md docs/desk-server.md agent/.env.example CLAUDE.md
git commit -m "docs(agent): two users, a credential that is not a file, and a fourth kind"
```

---

## What this plan does not do, and who does it

- **The desk's half of the wire** — `ask` in `COMMAND_KINDS`, the `reply_to`
  and `lang` columns, `GET /api/commands/<cid>`, the push on `done` — is
  section 2 and is planned separately. Every test here fakes the desk, so no
  task above blocks on it. Task 7's outcome strings are the contract between
  the two plans.
- **The phone** is section 4.
- **The end-to-end run** in spec section 5 — compose up beside a local desk,
  post an `ask` from the simulator, watch the container answer it, then a
  second message that changes the paper — needs all three halves and belongs to
  whoever assembles the PR. It is not a task here because two thirds of it does
  not exist yet.
- **An egress allowlist** is out of scope by the spec's own last section.

## Self-review

**Spec coverage.** Section 1: the whole worker in the container (Tasks 1, 3, 8);
two users (Tasks 1, 2) — implemented as root + `model` rather than `worker` +
`model`, because the spec's mechanism does not work and this plan says so and
measures it; `/run/secrets` (Task 3) — replaced rather than chmodded, for the
same reason; `/context` read-only and world-readable (Task 3, unchanged from
today); the Claude login reaching `model` only in that child's environment (Task
2's `child_env`); `DEFAULT_TOOLS` unchanged (Global Constraints); the honest
paragraph about outbound internet (Task 9); image changes and `install-docker.sh`
(Tasks 1, 8). Section 3: `AGENT_RUN_AS` and `claude_argv` (Task 2); seeding
`current/` and `previous.md` (Task 5); the prompt's three rules verbatim (Task
6); the three outcomes after the run (Task 7); `command()` and `fetch_public()`
(Task 4). Section 5's agent rows (Tasks 2, 5, 6, 7) and image rows (Task 1).

Two additions the spec implies but does not name: `DeskClient.command_notes()`,
forced by its own sentence that `previous.md` carries the earlier answer, which
lives at `/api/commands/<cid>/notes.md`; and `ask_lang`, forced by its rule 1
having a fallback that is not the edition's language.

One thing the spec's section 1 asks for that this plan does **not** build: an
entrypoint script. With the loop as root there is nothing for it to do —
`/scratch` is created in the image and each command's directory is chowned by
`own_workdir`, which has to happen per command anyway.

**Placeholder scan.** Every step carries the code or the exact command. Three
steps say "read the class first" (Task 3's `WatchlistTest` attribute names, Task
7's `SeedingSplitTest` helper) — that is a real instruction about an existing
file rather than a deferral, and the assertion to write is given in full.

**Type consistency.** `Settings.run_as` (str, `""` when unset) is used by
`claude_argv`, `child_env`, `own_workdir` and `main`. `run_as_home(user) -> str`
is called by `child_env` and asserted directly. `read_answer`/`read_notes` both
return `str | None` over `_read_workdir_text`. `put_notes_best_effort(desk,
text, *, draft=None, command=None)` keeps `file_notes`' keyword-only shape, and
`file_notes` still exists with its old signature, so `upload()` and
`note_on_command()` are untouched. `fetch_public(path) -> bytes | None`,
`command(cid) -> dict`, `command_notes(cid) -> str | None` are used exactly as
Task 4 defines them by Task 5's `seed_current`/`seed_previous`. `ASK_KIND`,
`CURRENT_DIR`, `ANSWER_NAME`, `PREVIOUS_NAME` and `ASK_STATES` are defined in
Task 5 (the first four) and Task 7 (the last), and used only after.
`build_prompt`'s new `ask_lang` keyword is added in Task 6 and passed in Task 7.
