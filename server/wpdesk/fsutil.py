"""The one atomic write, and the directory flush that makes it durable.

Three modules need to replace a file without ever being seen half-written --
the pointer that says which edition is current, an edition's ``news.json``, the
schedule the operator edited -- and all three have the same failure to avoid:
a reader arriving mid-write. A partially written ``current`` is a pointer to
nowhere; a partially written ``news.json`` is a front page the board fetches
and refuses. So there is one implementation here rather than one per caller,
because a second copy is a second thing to get right and the day they diverge
the wrong one will be the one holding the pointer.

``os.replace`` is atomic within a filesystem, which is why the temporary file
is made in the *same directory* as its destination rather than in ``/tmp``: a
rename across filesystems is a copy, and a copy is exactly the half-written
state this module exists to prevent.
"""

from __future__ import annotations

import os
import tempfile


def atomic_write(path: str, data: bytes) -> None:
    """Replace ``path`` with ``data``, or leave the previous file untouched.

    A temporary file in the same directory, ``fsync``, then ``os.replace``.
    The directory is synced afterwards so the rename itself survives a power
    cut -- without it the new bytes are on the disk and the name still points
    at the old ones.

    The temporary file is unlinked on any exception, including a
    ``KeyboardInterrupt``: a desk that has been restarted a few hundred times
    mid-write should not be a directory full of ``.wpdesk-*.tmp``.
    """
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".wpdesk-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(directory)


def fsync_dir(path: str) -> None:
    """Flush a directory entry. Best effort: not every filesystem allows it."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass                    # some filesystems refuse; the replace still held
    finally:
        os.close(fd)
