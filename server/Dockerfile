# The desk image.
#
# Two stages, and the split is the point. The builder compiles the simulator --
# the real news_core, the real seven faces, the real compositor, the real
# six-ink quantizer -- so that the runtime image can typeset a candidate edition
# before it reaches a wall. The runtime image then carries the binary and no
# toolchain, because this container answers a Cloudflare tunnel and a C compiler
# on the far side of one is a capability nobody needs to be given.
#
# Building the simulator at image-build time rather than at first use also moves
# a broken build from 06:00 on a weekday to `docker build`, which is the only
# time anybody is watching.
#
# Build context is the REPOSITORY ROOT, not this directory:
#     docker build -f server/Dockerfile -t wpnews-desk .
# Compose does that for you.

# ---------------------------------------------------------------- builder ---
FROM python:3.14-slim AS builder

# git is here for the LVGL FetchContent fallback in sim/CMakeLists.txt: there is
# no ESP-IDF in this image, so managed_components/ is empty and the simulator
# fetches the version the firmware pins.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git ca-certificates libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY components/ components/
COPY sim/ sim/
COPY third_party/ third_party/
COPY main/ main/
COPY CMakeLists.txt ./

RUN cmake -S sim -B sim/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build sim/build -j "$(nproc)" \
    && test -x sim/build/sim

# ---------------------------------------------------------------- runtime ---
FROM python:3.14-slim

# libcurl4 is the simulator's one runtime dependency (http_port_curl.c).
# tzdata is not optional: zoneinfo reads the system database and the slim image
# ships none, so without it every schedule in Asia/Seoul silently becomes UTC.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libcurl4 tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A fixed uid so the named data volume has stable ownership across rebuilds.
# The desk never needs root: it binds 8080, not 80.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin desk

WORKDIR /repo

# The repo, minus everything the desk does not run. gates.py shells out to
# tools/mock_news_server.py and tools/edition/render-check.sh, and render-check
# needs the fonts and fixtures under sim/, so those come across whole.
COPY --chown=desk:desk tools/ tools/
COPY --chown=desk:desk sim/ sim/
COPY --chown=desk:desk components/ components/
COPY --chown=desk:desk third_party/ third_party/
COPY --chown=desk:desk docs/news-contract.md docs/news-contract.md
COPY --chown=desk:desk server/wpdesk/ /app/wpdesk/

# The prebuilt simulator, at the path render-check.sh looks for it.
COPY --from=builder --chown=desk:desk /src/sim/build/sim /repo/sim/build/sim

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    WPDESK_DATA=/data \
    WPDESK_SECRETS=/run/secrets \
    WPDESK_REPO=/repo \
    WPDESK_HOST=0.0.0.0 \
    WPDESK_PORT=8080

RUN mkdir -p /data && chown desk:desk /data
VOLUME ["/data"]

USER desk
EXPOSE 8080

# The device plane's liveness path, which needs no token by design -- an
# unauthenticated health check is the one thing every orchestrator wants and the
# one thing that leaks nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"

CMD ["python3", "-m", "wpdesk"]
