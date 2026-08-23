"""What may be PUT into a draft, and how much of it.

The id rule is ``ui_tile.c``'s ``id_ok()`` -- letters, digits, underscore and
hyphen, fifteen bytes -- restated here because the id becomes a path component
on this side too. "The device would have rejected it anyway" is not a defence
against a traversal on the desk, and the desk is the machine that answers a
tunnel.

The byte counts are transport limits and nothing more. Whether a tile's length
agrees with the ``w * h / 2`` its payload declared is gate 1's question, and
``tools/mock_news_server.py --validate`` already answers it against the
declared dimensions. Duplicating that here would give two answers to maintain
and one of them would eventually be wrong.
"""

from __future__ import annotations

import re

from .errors import BadRequest, TooLarge

#: The device caps a response at 320 KB (``http_port_esp.c:32``). Serving a
#: payload larger than it will fetch is serving a page nobody sees, so the cap
#: sits below the device's rather than at it.
MAX_PAYLOAD_BYTES = 300 * 1024

#: A full-sheet 1200 x 1600 tile at 4 bpp. Nothing larger can exist, because
#: nothing larger fits the panel.
MAX_TILE_BYTES = 960_000

#: The contract allows five story photographs and two thumbnails. Sixteen is
#: generous and, more to the point, finite.
MAX_TILES = 16

#: Drafts are cheap but not free -- each is a directory a gate may be about to
#: run over. Eight is more concurrent producers than this desk will ever have.
MAX_DRAFTS = 8

#: Exactly ``ui_tile.c``'s ``id_ok()``: no dot, no slash, no percent.
TILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,15}$")


def valid_tile_id(s: str) -> bool:
    """True when ``s`` is an id both the desk and the device will accept."""
    return isinstance(s, str) and TILE_ID_RE.match(s) is not None


def check_payload_size(data: bytes) -> None:
    """Raise :class:`TooLarge` for a payload the device could not fetch."""
    if len(data) > MAX_PAYLOAD_BYTES:
        raise TooLarge(message=f"{len(data)} bytes, limit {MAX_PAYLOAD_BYTES}")


def check_tile(tile_id: str, data: bytes) -> None:
    """Raise unless ``tile_id`` is well formed and ``data`` is a plausible tile.

    The id is checked before the bytes are looked at, because an id that would
    become a path is a fault regardless of what followed it.
    """
    if not valid_tile_id(tile_id):
        raise BadRequest(message=f"tile id {tile_id!r} is not [A-Za-z0-9_-]{{1,15}}")
    if not data:
        raise BadRequest(message="an empty tile is not a picture")
    if len(data) > MAX_TILE_BYTES:
        raise TooLarge(message=f"{len(data)} bytes, limit {MAX_TILE_BYTES}")
