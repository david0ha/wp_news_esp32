"""The vault bridge, tested mostly by taking the vault away.

Every other module here is tested for what it does. This one is tested for what
it declines to do when the disk it reads is not there, because that is the
property the whole design rests on: pulling an SSD out of a laptop must not be
able to blank a newspaper hanging on a wall.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from wpdesk import schedule as S
from wpdesk import vault as V
from wpdesk.clock import FixedClock
from wpdesk.errors import BadRequest

# The module logs a warning the first time the vault goes missing, which is the
# behaviour the spec asks for and not something a passing test should print.
logging.getLogger("wpdesk.vault").addHandler(logging.NullHandler())

KST = ZoneInfo("Asia/Seoul")
NOW = datetime(2026, 8, 18, 9, 0, tzinfo=KST).timestamp()
DAY = 86400.0


class VaultCase(unittest.TestCase):
    """A temporary vault root, a temporary cache and a clock that does not move."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.root = os.path.join(self.tmp, "vault")
        self.cache = os.path.join(self.tmp, "data", "schedule.cache.json")
        self.clock = FixedClock(NOW)

    def vault(self, root: str | None = None) -> V.Vault:
        return V.Vault(self.root if root is None else root, self.cache, self.clock)

    def make_root(self) -> str:
        os.makedirs(self.root, exist_ok=True)
        return self.root

    def write(self, name: str, text: str) -> str:
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path


class MissingVaultTest(VaultCase):
    """The SSD is not plugged in. Nothing here may raise.

    The root is nested under two directories that do not exist either, because
    that is what an unplugged disk actually looks like: not an empty `wpnews`
    directory but a missing `/Volumes/ssd` above it.
    """

    def setUp(self):
        super().setUp()
        self.root = os.path.join(self.tmp, "Volumes", "ssd", "wpnews")

    def test_a_missing_root_is_not_available(self):
        self.assertFalse(self.vault().available())

    def test_a_missing_root_falls_back_to_the_cache(self):
        kept = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                                | {"timezone": "Europe/Lisbon"})
        os.makedirs(os.path.dirname(self.cache), exist_ok=True)
        with open(self.cache, "w", encoding="utf-8") as f:
            json.dump(S.schedule_to_dict(kept), f)
        got, source = self.vault().load_schedule()
        self.assertEqual(got, kept)
        self.assertEqual(source, "cache")

    def test_with_no_cache_either_it_is_the_default(self):
        got, source = self.vault().load_schedule()
        self.assertEqual(got, S.DEFAULT_SCHEDULE)
        self.assertEqual(source, "default")

    def test_context_is_empty_strings_rather_than_an_exception(self):
        ctx = self.vault().context()
        self.assertEqual(set(ctx), {"standing", "blocklist", "watchlist"})
        self.assertEqual(list(ctx.values()), ["", "", ""])

    def test_write_brief_reports_failure_rather_than_raising(self):
        self.assertEqual(self.vault().write_brief("2026-08-18", "filed NOTHING"), "")

    def test_the_rest_of_the_surface_is_equally_quiet(self):
        v = self.vault()
        src = os.path.join(self.tmp, "edition")
        os.makedirs(src)
        with open(os.path.join(src, "news.json"), "w", encoding="utf-8") as f:
            f.write("{}")
        v.ensure_layout()          # the parent is missing; see LayoutTest
        v.archive("e1", src)
        self.assertEqual(v.prune_archive(30), 0)
        self.assertEqual(v.read_text(V.STANDING_FILE), "")
        self.assertFalse(v.poll())

    def test_saving_still_reaches_the_cache_when_the_vault_is_gone(self):
        # A schedule set over the API while the disk is out must still take
        # effect; it simply cannot be written where a human would read it.
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"publish": {"policy": "manual", "min_gap_minutes": 5}})
        v = self.vault()
        v.save_schedule(s)
        self.assertTrue(os.path.exists(self.cache))
        self.assertEqual(v.load_schedule(), (s, "cache"))


class LayoutTest(VaultCase):

    def test_it_creates_the_files_on_an_empty_directory(self):
        self.make_root()
        self.vault().ensure_layout()
        for name in (V.README_FILE, V.STANDING_FILE, V.BLOCKLIST_FILE,
                     V.WATCHLIST_FILE, V.SCHEDULE_FILE):
            self.assertTrue(os.path.exists(os.path.join(self.root, name)), name)
        self.assertTrue(os.path.isdir(os.path.join(self.root, V.BRIEFS_DIR)))
        self.assertTrue(os.path.isdir(os.path.join(self.root, V.ARCHIVE_DIR)))

    def test_it_changes_nothing_on_a_populated_one(self):
        self.make_root()
        mine = {V.STANDING_FILE: "Lead on the semiconductor cycle.\n",
                V.BLOCKLIST_FILE: "- NOBODY\n",
                V.WATCHLIST_FILE: '{"symbols": [{"symbol": "AAAA"}]}\n',
                V.SCHEDULE_FILE: json.dumps(S.schedule_to_dict(
                    S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                                     | {"timezone": "Europe/Lisbon"}))),
                V.README_FILE: "mine, not yours\n"}
        for name, text in mine.items():
            self.write(name, text)
        self.vault().ensure_layout()
        for name, text in mine.items():
            with open(os.path.join(self.root, name), encoding="utf-8") as f:
                self.assertEqual(f.read(), text, name)

    def test_the_root_is_not_manufactured_where_a_disk_belongs(self):
        # /Volumes/ssd is not there, and inventing it would leave an empty vault
        # on the internal disk that looks exactly like a real one.
        root = os.path.join(self.tmp, "Volumes", "ssd", "wpnews")
        self.vault(root).ensure_layout()
        self.assertFalse(os.path.exists(root))

    def test_the_defaults_carry_nobodys_editorial_voice(self):
        self.make_root()
        self.vault().ensure_layout()
        with open(os.path.join(self.root, V.WATCHLIST_FILE), encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(doc["symbols"], [])
        with open(os.path.join(self.root, V.SCHEDULE_FILE), encoding="utf-8") as f:
            self.assertEqual(S.parse_schedule(json.load(f)), S.DEFAULT_SCHEDULE)

    def test_what_it_wrote_is_what_it_reads_back(self):
        self.make_root()
        v = self.vault()
        v.ensure_layout()
        self.assertEqual(v.load_schedule(), (S.DEFAULT_SCHEDULE, "vault"))


class ScheduleTest(VaultCase):

    def test_save_writes_the_vault_and_the_cache(self):
        self.make_root()
        v = self.vault()
        s = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                             | {"wake": ["07:15"], "quiet": []})
        v.save_schedule(s)
        self.assertTrue(os.path.exists(os.path.join(self.root, V.SCHEDULE_FILE)))
        self.assertTrue(os.path.exists(self.cache))
        self.assertEqual(v.load_schedule(), (s, "vault"))

    def test_the_vault_is_the_one_that_is_believed(self):
        self.make_root()
        v = self.vault()
        v.save_schedule(S.DEFAULT_SCHEDULE)
        edited = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                                  | {"timezone": "Europe/Lisbon"})
        self.write(V.SCHEDULE_FILE, json.dumps(S.schedule_to_dict(edited)))
        self.assertEqual(v.load_schedule(), (edited, "vault"))

    def test_a_bad_edit_leaves_the_previous_schedule_in_force(self):
        self.make_root()
        v = self.vault()
        good = S.parse_schedule(S.schedule_to_dict(S.DEFAULT_SCHEDULE)
                                | {"wake": ["05:45"]})
        v.save_schedule(good)
        doc = S.schedule_to_dict(good)
        doc["poll"]["active_seconds"] = 5
        self.write(V.SCHEDULE_FILE, json.dumps(doc))
        self.assertEqual(v.load_schedule(), (good, "cache"))

    def test_a_bad_edit_says_which_field_was_wrong(self):
        self.make_root()
        v = self.vault()
        doc = S.schedule_to_dict(S.DEFAULT_SCHEDULE)
        doc["poll"]["active_seconds"] = 5
        self.write(V.SCHEDULE_FILE, json.dumps(doc))
        v.load_schedule()
        with open(os.path.join(self.root, V.ERRORS_FILE), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("poll.active_seconds", text)

    def test_a_file_that_is_not_json_at_all_is_reported_the_same_way(self):
        self.make_root()
        v = self.vault()
        self.write(V.SCHEDULE_FILE, "{ this is not json")
        got, source = v.load_schedule()
        self.assertEqual((got, source), (S.DEFAULT_SCHEDULE, "default"))
        self.assertTrue(os.path.exists(os.path.join(self.root, V.ERRORS_FILE)))

    def test_the_complaint_is_withdrawn_once_the_file_parses(self):
        self.make_root()
        v = self.vault()
        self.write(V.SCHEDULE_FILE, "{ this is not json")
        v.load_schedule()
        self.write(V.SCHEDULE_FILE, json.dumps(S.schedule_to_dict(S.DEFAULT_SCHEDULE)))
        v.load_schedule()
        self.assertFalse(os.path.exists(os.path.join(self.root, V.ERRORS_FILE)))


class PollTest(VaultCase):

    def test_nothing_changed_is_false_twice_running(self):
        self.make_root()
        self.write(V.STANDING_FILE, "one line\n")
        v = self.vault()
        self.assertFalse(v.poll())
        self.assertFalse(v.poll())

    def test_an_edit_is_seen_once_and_then_is_old_news(self):
        self.make_root()
        self.write(V.STANDING_FILE, "one line\n")
        v = self.vault()
        self.assertFalse(v.poll())
        self.write(V.STANDING_FILE, "one line, then another\n")
        self.assertTrue(v.poll())
        self.assertFalse(v.poll())

    def test_the_disk_coming_back_is_itself_a_change(self):
        v = self.vault()
        self.assertFalse(v.poll())
        self.make_root()
        self.assertTrue(v.poll())

    def test_the_desks_own_write_is_not_reported_as_somebodys_edit(self):
        self.make_root()
        v = self.vault()
        v.save_schedule(S.DEFAULT_SCHEDULE)
        self.assertFalse(v.poll())


class TextTest(VaultCase):

    def test_context_returns_what_the_owner_wrote(self):
        self.make_root()
        self.write(V.STANDING_FILE, "Lead on the cycle.")
        self.write(V.BLOCKLIST_FILE, "- NOBODY")
        ctx = self.vault().context()
        self.assertEqual(ctx["standing"], "Lead on the cycle.")
        self.assertEqual(ctx["blocklist"], "- NOBODY")
        self.assertEqual(ctx["watchlist"], "")

    def test_a_runaway_file_is_cut_visibly_rather_than_silently(self):
        # This text ends up in a model's context. A file that was truncated has
        # to say so, or the agent reads a standing instruction that stops
        # mid-sentence and treats the half it got as the whole of it.
        self.make_root()
        self.write(V.STANDING_FILE, "x" * (V.MAX_TEXT_BYTES + 4096))
        got = self.vault().read_text(V.STANDING_FILE)
        self.assertIn("truncated", got)
        self.assertEqual(got.count("x"), V.MAX_TEXT_BYTES)

    def test_a_name_that_would_leave_the_vault_is_refused(self):
        self.make_root()
        v = self.vault()
        for bad in ("../tokens.json", "/etc/passwd", "briefs/../../x", ""):
            with self.assertRaises(BadRequest, msg=bad):
                v.read_text(bad)

    def test_a_brief_is_appended_rather_than_replaced(self):
        self.make_root()
        v = self.vault()
        path = v.write_brief("2026-08-18", "morning: filed the semis piece")
        self.assertEqual(v.write_brief("2026-08-18", "evening: filed the accounts"), path)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("morning: filed the semis piece", text)
        self.assertIn("evening: filed the accounts", text)

    def test_a_day_that_is_not_a_date_is_refused_before_it_becomes_a_path(self):
        self.make_root()
        for bad in ("../../etc/passwd", "2026-8-18", "today", ""):
            with self.assertRaises(BadRequest, msg=bad):
                self.vault().write_brief(bad, "x")


class ArchiveTest(VaultCase):

    def edition(self, eid: str) -> str:
        src = os.path.join(self.tmp, "editions", eid)
        os.makedirs(os.path.join(src, "tiles"), exist_ok=True)
        with open(os.path.join(src, "news.json"), "w", encoding="utf-8") as f:
            f.write('{"edition":"%s"}' % eid)
        with open(os.path.join(src, "tiles", "a.bin"), "wb") as f:
            f.write(b"\x01\x02")
        return src

    def test_it_copies_the_edition_and_its_tiles(self):
        self.make_root()
        self.vault().archive("e1", self.edition("e1"))
        dest = os.path.join(self.root, V.ARCHIVE_DIR, "e1")
        with open(os.path.join(dest, "news.json"), encoding="utf-8") as f:
            self.assertEqual(f.read(), '{"edition":"e1"}')
        self.assertTrue(os.path.exists(os.path.join(dest, "tiles", "a.bin")))

    def test_archiving_twice_leaves_the_first_copy_alone(self):
        self.make_root()
        v = self.vault()
        v.archive("e1", self.edition("e1"))
        dest = os.path.join(self.root, V.ARCHIVE_DIR, "e1", "news.json")
        with open(dest, "w", encoding="utf-8") as f:
            f.write("annotated by hand")
        v.archive("e1", self.edition("e1"))
        with open(dest, encoding="utf-8") as f:
            self.assertEqual(f.read(), "annotated by hand")

    def test_prune_removes_the_old_and_keeps_the_new(self):
        self.make_root()
        v = self.vault()
        v.archive("old", self.edition("old"))
        v.archive("new", self.edition("new"))
        old = os.path.join(self.root, V.ARCHIVE_DIR, "old")
        os.utime(old, (NOW - 40 * DAY, NOW - 40 * DAY))
        self.assertEqual(v.prune_archive(30), 1)
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(os.path.join(self.root, V.ARCHIVE_DIR, "new")))

    def test_an_id_that_would_leave_the_archive_is_refused(self):
        self.make_root()
        v = self.vault()
        for bad in ("../standing.md", "a/b", "", "."):
            with self.assertRaises(BadRequest, msg=bad):
                v.archive(bad, self.edition("e1"))


if __name__ == "__main__":
    unittest.main()
