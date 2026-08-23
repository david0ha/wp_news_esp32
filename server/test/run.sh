#!/bin/sh
# run.sh -- layer 0.
#
# Faster than every other layer in this project and needs neither Docker nor a
# network, which is the whole reason it goes first. It exercises the schedule
# arithmetic, the publish gating, the queue's exactly-once claim, the token
# scopes, and the one property the device plane exists to have: that nothing
# but the edition and its tiles is reachable without a token.
#
#   sh server/test/run.sh
#   sh server/test/run.sh -k schedule      # one module
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$here/.."

# The package is imported as `claudepost`, so the server directory is the root and
# the tests live beside it rather than inside it. Adding `test` to the path is
# what lets test_policy.py reuse test_schedule.py's date helper instead of
# keeping a second copy of it.
PYTHONPATH="$here/..:$here${PYTHONPATH:+:$PYTHONPATH}" \
    exec python3 -m unittest discover -s test -t test -p 'test_*.py' -v "$@"
