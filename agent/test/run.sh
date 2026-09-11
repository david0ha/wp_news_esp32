#!/bin/sh
# run.sh -- the worker's layer 0.
#
# The same shape as server/test/run.sh and for the same reason: it needs neither
# Docker, nor a network, nor an API key, so it is the check that can run on every
# save. What it covers is the two halves of the worker that are worth being sure
# about without a desk in front of them -- the prompt that is assembled from the
# shipped contract plus whatever the operator brought, and the HTTP client that
# talks to the desk -- plus the loop itself: what it decides on its own about
# configuration and about seeding and filing each kind of command, everything
# else about it being a claim, a subprocess and a commit that a fake desk and
# a fake subprocess can stand in for here.
#
#   sh agent/test/run.sh
#   sh agent/test/run.sh -k prompt      # one module
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$here/.."

# The worker runs as a script rather than as a package -- `python3 loop.py` --
# so its modules are top-level imports and the agent directory is the root.
# `test` is on the path too, mirroring the desk's runner, so a helper can be
# shared between the two test modules instead of copied into both.
PYTHONPATH="$here/..:$here${PYTHONPATH:+:$PYTHONPATH}" \
    exec python3 -m unittest discover -s test -t test -p 'test_*.py' -v "$@"
