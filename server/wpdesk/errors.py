"""The one exception type the HTTP layer knows how to turn into a response.

Every failure inside the desk carries the wire code it will be reported as, so
the code that raises the error is the code that names it. The alternative -- a
translation table at the boundary -- drifts the moment somebody adds a raise
without touching the table, and the symptom is a 500 where a 400 was meant.

The envelope matches ``components/device_api/device_api.c``:
``{"ok": false, "error": "<code>"}`` with a 4xx. A client that speaks to the
board therefore speaks to the desk, which matters because the same phone app
and the same shell scripts talk to both.

``detail`` is added only when there is something to say beyond the code. It is
for a human reading a terminal, never for a client to branch on -- the code is
the contract and the detail is prose.
"""

from __future__ import annotations


class DeskError(Exception):
    """A failure with the wire code and HTTP status it will be reported as."""

    #: Subclasses override these; the constructor may override them again.
    default_code = "bad_request"
    default_status = 400

    def __init__(self, code: str | None = None, message: str = "",
                 status: int | None = None) -> None:
        self.code = code or self.default_code
        self.message = message
        self.status = status if status is not None else self.default_status
        super().__init__(f"{self.code}: {message}" if message else self.code)

    def to_json(self) -> dict:
        """The response body, in the board's own error envelope."""
        body: dict = {"ok": False, "error": self.code}
        if self.message:
            body["detail"] = self.message
        return body


class BadRequest(DeskError):
    """The caller sent something this endpoint cannot use."""

    default_code = "bad_request"
    default_status = 400


class Unauthorized(DeskError):
    """No credential, or one the desk does not know."""

    default_code = "unauthorized"
    default_status = 401


class Forbidden(DeskError):
    """A real credential, of the wrong scope."""

    default_code = "forbidden"
    default_status = 403


class NotFound(DeskError):
    """No such draft, edition, tile or route.

    This is also what the device plane answers for everything it does not
    serve, which is the point of that plane: a path that is not the edition or
    a tile does not exist, rather than existing and being refused.
    """

    default_code = "not_found"
    default_status = 404


class Conflict(DeskError):
    """The request is legal but the desk's current state will not have it.

    Too many open drafts, too many tiles, a command that is already claimed.
    """

    default_code = "conflict"
    default_status = 409


class TooLarge(DeskError):
    """Over a transport limit.

    The payload limit is not a preference: the device caps a response at 320 KB
    (``components/news_core/http_port_esp.c:32``), so serving something larger
    is serving a page nobody can fetch.
    """

    default_code = "too_large"
    default_status = 413
