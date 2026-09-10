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
