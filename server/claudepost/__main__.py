"""Start the desk: read the environment, open the door, serve until told to stop.

Everything interesting is elsewhere. What lives here is the three things a
container entry point owns and nothing else owns: turning the environment into a
:class:`~claudepost.app.Config`, arranging for SIGTERM to be a clean shutdown rather
than a killed process holding a half-written pointer file, and saying enough at
startup that a log tail answers "is it configured the way I think it is".

    python3 -m claudepost
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading

from .app import Config, Desk
from .http import serve_forever


def _configure_logging() -> None:
    """One line format, level from the environment.

    INFO is one line per publish, plus a handful at startup.
    DEBUG adds a line per request, which against a board polling every fifteen
    minutes forever is a great many lines saying that nothing happened.
    """
    logging.basicConfig(
        level=os.environ.get("CLAUDEPOST_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
        stream=sys.stdout)


def main() -> int:
    _configure_logging()
    log = logging.getLogger("claudepost")

    cfg = Config.from_env(os.environ)
    desk = Desk(cfg)

    log.info("data %s", cfg.data_dir)
    log.info("schedule %s (%s)", desk.schedule_path, desk.schedule_source)
    log.info("tokens %s (%d)", cfg.tokens_path, desk.tokens.count())
    if desk.tokens.count() == 0:
        # Not fatal: the device plane still serves, which is the half that keeps
        # a newspaper on a wall. But nothing can be filed or told to it, and
        # that is worth a line somebody will actually see.
        log.warning("no tokens — the control plane will refuse everything. "
                    "Run server/tools/mint-token.sh")

    current = desk.editions.current_id()
    log.info("current edition %s", current or "(none filed yet)")

    # SIGTERM is what `docker stop` sends, and the default action is to kill the
    # process. Serving state is already durable -- a publish is a rename -- so
    # this is not about consistency; it is so that the log ends with a line
    # saying the desk stopped, rather than simply stopping.
    stopping = threading.Event()

    def handle(signum, _frame):
        log.info("signal %d — stopping", signum)
        stopping.set()
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)

    try:
        serve_forever(desk)
    except KeyboardInterrupt:
        pass
    finally:
        desk.close()
        log.info("desk stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
