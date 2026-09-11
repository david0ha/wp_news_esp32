# The worker image.
#
# The agent is a separate container from the desk on purpose. The desk is a
# condition that must hold continuously -- the board polls whether or not
# anything has been filed since dawn -- and the worker is an event that happens
# a few times a day and is allowed to fail. Putting them in one container makes
# a failed filing take the served page down with it, which converts a stale
# paper (the failure the firmware is designed to survive and badge) into no
# paper at all. That is the same argument agent/standalone/README.md makes for
# splitting com.claudepost.edition from com.claudepost.serve, and it does not
# stop being true inside Docker.
#
# The worker holds the operator's credentials and, if one is mounted, reads a
# directory of their own notes. The desk holds neither, and is the only one of
# the two exposed through the tunnel.
#
# Build context is the REPOSITORY ROOT:
#     docker build -f agent/Dockerfile -t claudepost-agent .

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
