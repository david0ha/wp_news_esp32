# The worker image.
#
# The agent is a separate container from the desk on purpose. The desk is a
# condition that must hold continuously -- the board polls whether or not
# anything has been filed since dawn -- and the worker is an event that happens
# a few times a day and is allowed to fail. Putting them in one container makes
# a failed filing take the served page down with it, which converts a stale
# paper (the failure the firmware is designed to survive and badge) into no
# paper at all. That is the same argument agent/standalone/README.md makes for
# splitting com.claudepost.edition from com.claudepost.serve, and it does not stop being
# true inside Docker.
#
# The worker holds the operator's credentials and, if one is mounted, reads a
# directory of their own notes. The desk holds neither, and is the only one of
# the two exposed through the tunnel.
#
# Build context is the REPOSITORY ROOT:
#     docker build -f agent/Dockerfile -t claudepost-agent .

FROM node:22-slim

# python3 runs the loop and the two repo tools the prompt names; curl is for a
# human debugging inside the container. git is absent deliberately -- the worker
# has no business pushing anything.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# The same uid as the desk, so a directory bind-mounted into both has one owner
# rather than two that disagree.
RUN useradd --create-home --uid 10001 --shell /bin/bash worker

WORKDIR /repo
COPY --chown=worker:worker tools/ tools/
# The three modules the loop is, and nothing else. Not agent/ wholesale:
# standalone/ is a different program that runs on a Mac with launchd, and test/
# is the harness -- neither belongs in an image whose job is to run one script.
COPY --chown=worker:worker agent/*.py /app/agent/

ENV PYTHONUNBUFFERED=1 \
    CLAUDEPOST_DESK=http://desk:8080 \
    CLAUDEPOST_SECRETS=/run/secrets \
    CLAUDEPOST_REPO=/repo \
    CLAUDEPOST_SCRATCH=/scratch \
    HOME=/home/worker

RUN mkdir -p /scratch && chown worker:worker /scratch

USER worker
CMD ["python3", "/app/agent/loop.py"]
