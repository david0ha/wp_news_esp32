"""The desk -- the always-on service that owns the URL the board polls.

The board polls one URL and nothing in the firmware knows what answers it. This
package is the third thing that can: a service holding the current edition, a
queue agents push instructions into from anywhere, a schedule deciding when a
new page may reach the glass, and a gate that typesets every candidate through
the real ``news_core`` before it does.

See ``docs/desk-server.md`` for the architecture and the arguments behind it,
and ``docs/superpowers/specs/2026-08-18-desk-server-design.md`` for the design
it was built from.

Standard library only, deliberately. The load is one board and two or three
agents; a framework would put a lock file and a wheel build into a public
repository for an API of about twenty endpoints.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
