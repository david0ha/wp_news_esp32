"""The file operations more than one module needs, each kept here once.

Nothing in this module is interesting on its own; what it is for is that the
alternative to each of these is a second copy of it somewhere else, and the
day two copies diverge the wrong one is the one holding the pointer. So the
rule for what belongs here is narrow: a second caller, and a reason the two
have to agree.

The atomic write is the oldest of them and still the argument for the rest.
Three modules need to replace a file without ever being seen half-written --
the pointer that says which edition is current, an edition's ``news.json``, the
schedule the operator edited -- and all three have the same failure to avoid:
a reader arriving mid-write. A partially written ``current`` is a pointer to
nowhere; a partially written ``news.json`` is a front page the board fetches
and refuses.

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
    mid-write should not be a directory full of ``.claudepost-*.tmp``.
    """
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(
        dir=directory, prefix=".claudepost-", suffix=".tmp")
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


def read_bytes(path: str) -> bytes | None:
    """A whole file, or ``None``. The serving path's one way of failing.

    Every caller of this is answering a request, and every way of failing --
    the file was never written, the directory was pruned a second ago, the
    pointer names something somebody deleted -- is the same 404 to whoever
    asked. So there is nothing for an exception to carry that the ``None`` does
    not already say, and a route that had to catch one would be a route that
    could forget to.

    The counterpart, for a read whose result is about to be *written*, is
    :func:`claudepost.editions._read_or_raise`: an edition is immutable, so a
    byte lost on the way in is lost for as long as the edition is kept, and
    that read must raise rather than answer nothing.
    """
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def file_stamp(path: str) -> tuple[int, int, int] | None:
    """The file's identity, as far as "has it changed" needs to know.

    Inode, size and modification time in nanoseconds; ``None`` for a file that
    is not there, which is a state both callers have to hold rather than an
    error -- the desk comes up on a machine whose secrets mount is empty and
    the credentials arrive when they arrive.

    Two objects re-read a file when it moves underneath the process --
    :class:`claudepost.auth.Tokens` and :class:`claudepost.quotes.Credentials`
    -- and the second was written from the first. What they are watching for is
    a rotation *in place*, where an mtime alone can miss a write landing in the
    same nanosecond as the last one and an inode alone misses a file rewritten
    through the same directory entry; the three together are what makes a
    dropped-in key take effect on the next request rather than the next restart.
    Which is to say the tuple is an argument, not a detail, and it should be one
    argument rather than two copies of it.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_ino, st.st_size, st.st_mtime_ns)


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
