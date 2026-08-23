# Deep sleep: a wake path that never powers the panel

*2026-08-17. Supersedes nothing; extends the boot policy established when
`epd6_init()` stopped refreshing. Read that section of
[CLAUDE.md](../../CLAUDE.md) first — this is the same argument taken to its
conclusion. The task-by-task plan this was built from is
[docs/superpowers/plans/2026-08-17-deep-sleep.md](../superpowers/plans/2026-08-17-deep-sleep.md).*

> **2026-08-24 — superseded in part.** The board now shares a desk server
> ([docs/desk-server.md](../desk-server.md)), and three things below are no
> longer what the code does. **The cadence comes from the desk when it sends
> one**: `power_cadence()` resolves `policy.poll_seconds` and `next_change`
> above the three local layers of §6, for a sleeping board and an awake one
> alike, and the local interval is the fallback rather than the answer. **Deep
> sleep defaults to on** rather than to off (§6), because the runtime gates and
> not the Kconfig switch are what decide. And the ext1 pins keep their pull-ups
> through the sleep — `power_sleep()` pins the RTC peripheral domain on, at a
> few µA — where §7 assumed the automatic behaviour was enough. Two smaller
> corrections: the failure count is cleared where a page reaches paper
> (`present_full()`) rather than where a wake decides to print, since a decision
> to print is not a print; and the ETag recipe is SHA-256 in both servers. The
> arguments below are otherwise unchanged and are still the reasoning of record.

This board is meant to hang on a wall like a picture frame and go months between
charges. It currently draws about 81 mA continuously, which is a little over two
days on a 4200 mAh cell. This document is how it gets to months.

## The fact that shapes everything

**Waking from deep sleep is not resuming. It is booting.**

Every byte of RAM is gone. PSRAM is gone. The 960,000-byte framebuffer is gone.
`sizeof(news_t)` is 32,952 bytes and RTC slow memory is 8 KB, so the snapshot has
no way to survive and no clever packing will make it.

What survives is **the glass**. Spectra 6 is bistable: cut the power entirely and
the last edition stays hanging there, indefinitely, drawing nothing. That single
property is the whole reason this design is possible, and it is why the design is
not "sleep between polls" but something narrower and stranger:

> **A wake that changes nothing must not power the panel, must not initialise
> LVGL, and must not allocate the framebuffer.**

Bolting `esp_deep_sleep_start()` onto the current boot path would miss this
entirely. Every wake would run `epd6_init()`, build 390 LVGL objects, and spend a
refresh — about 2.5 mAh. Ninety-six wakes a day is 240 mAh a day, and the board
would be flat in under three weeks having shown the reader nothing new. The sleep
is not the feature. **The quiet path is the feature.**

## 1. The boot splits in two

`main.cpp` today runs `epd6_init()` and `Lvgl_PortInit()` *before* provisioning.
Both move behind the decision.

```
app_main
├─ UserApp_AppInit · board_io_init · setenv(TZ)          [cheap, always]
├─ wake = esp_sleep_get_wakeup_cause()
│
├─ QUIET PATH   — taken only when: wake == TIMER
│  │                            && rtc_state.magic matches this firmware
│  │                            && deep sleep is enabled and permitted
│  │
│  │  prov_wifi_init(); prov_wifi_connect(ssid, pass, timeout)
│  │      └─ no portal, no SoftAP, no UI, no event callbacks
│  │  http_get_cond(url, .if_none_match = rtc_state.etag)
│  │
│  ├─ 304, or 200 whose news_hash() equals rtc_state.content_hash
│  │     → one log line, power_sleep()                    ★ panel never powered
│  │
│  └─ content changed → free the scratch, fall through, and let NewsTask
│                        fetch it again (see below)
│
└─ FULL PATH   — cold boot, EXT1 (button) wake, content changed, or any
                 failure of the quiet path's preconditions
     epd6_init · Lvgl_PortInit · UserApp_UiInit
     provisioning_run  (skipped if the quiet path already has an IP)
     render · one refresh
     power_sleep()
```

`prov_wifi_connect()` is already public and already does exactly the quiet
connect (`prov_wifi.h:24` — "Switches the radio to station-only mode … used on
the boot path"). Nothing new is needed for it.

The quiet path touches none of: GPIO43, SPI3, the two UC8179s, LVGL, the
framebuffer, `ui_news_create()`'s 390 objects, `device_api`, mDNS, SNTP.

### When the quiet path fails

Falling through to the full path is the *wrong* answer for most failures, and it
is the expensive kind of wrong. A board whose Wi-Fi has gone away would, on every
single wake, start the captive portal and spend a refresh saying so — 2.3 mAh
every fifteen minutes, about 220 mAh a day, which flattens the cell in under
three weeks while displaying a setup screen nobody is looking at.

So the quiet path resolves its own failures and only ever falls through for one
reason: **the content changed.**

| what happened | what the quiet path does |
|---|---|
| Wi-Fi connect timed out | count a failure, sleep (with backoff) |
| fetch failed at the transport | count a failure, sleep (with backoff) |
| HTTP status not 2xx / 304 | count a failure, sleep (with backoff) |
| payload rejected by `news_parse()` | count a failure, sleep — the previous snapshot is still on the glass and still correct, per the standing rule that a rejected payload leaves it alone |
| 304, or `news_hash()` unchanged | sleep, no failure |
| **content changed** | **fall through** |
| the failure count first crosses `STALE_SECONDS` | **nothing — see below.** This row was specified as "fall through once to badge the sheet `OFFLINE`" and could not be implemented |
| no URL configured (demo board) | `POWER_STAY_AWAKE` — a board with nothing to poll has no reason to wake, and the demo sheet is a complete configuration, not a placeholder |

**Only "content changed" reaches the panel.** That is one row, not two — this
document originally claimed the `OFFLINE` badge as a second, and it is wrong for
a reason that follows from §1's opening fact rather than from an implementation
difficulty.

To badge a sheet you must redraw it, and to redraw it you need a snapshot. A wake
is a boot, so the snapshot did not survive; the only thing that did is an image
on glass that cannot be read back. The only snapshot available on that path is
the one the fetch that just failed did not bring. So what would actually print is
the **demo page** — `user_app.c`'s documented answer when nothing arrives within
`FIRST_PAINT_WAIT_MS` — and the row as written spends 2.3 mAh to replace a real,
correct, merely stale front page with a story about a company the board invented.

Worse, this row is reached exactly when the network is down, and falling through
with no IP runs `provisioning_run()`, which never returns: one Wi-Fi outage would
park the board in a captive portal, awake, until the cell died.

The glass is left alone instead. A reader looking at a stale sheet sees its own
dateline; a reader looking at the demo sheet sees fiction.

### The changed-content wake fetches twice

`QuietFetch()` parses the payload to compute `news_hash()`, discovers the content
changed, and then frees it — and `NewsTask` fetches the same document again on
the full path. That is a second round trip for something the board had in hand
seconds earlier.

It is deliberate. Carrying the snapshot across would mean threading a
32,952-byte `news_t` from `app_main` through `UserApp_TaskInit` into `NewsTask`'s
state, and the measured saving is about one 20 KB transfer and a second of awake
time — roughly 0.02 mAh against the 2.3 mAh refresh that same wake is about to
spend, or about 1%. The simpler code is worth more than the 1%.

### Why the quiet path re-parses at all

It does not, when the server supports ETag — see §5. When the server does not,
the quiet path must parse to compute `news_hash()`, because **`news_hash()` is
the only thing allowed to decide whether the panel moves.** That costs a cJSON
tree and a 32 KB struct fill, both of which are already budgeted for and neither
of which powers anything. It is cheap compared to what it prevents.

## 2. What crosses the sleep

One `RTC_DATA_ATTR` struct in RTC slow memory. About 100 bytes of the 8 KB.

```c
typedef struct {
    uint32_t magic;              /* WP_RTC_MAGIC ^ build id — see below */
    uint32_t content_hash;       /* news_hash() of what is on the glass NOW */
    char     etag[HTTP_ETAG_MAX];/* the server's tag for that same content */
    uint32_t sleep_seconds;      /* the interval in force, so a change survives */
    uint16_t consecutive_fails;
    uint32_t wakes;              /* diagnostics */
    uint32_t awake_ms_total;     /* diagnostics — §9 */
    uint32_t quiet_wakes;        /* wakes that cost no refresh */
    int64_t  last_ok_unix;       /* the last poll that succeeded */
} wp_rtc_state_t;
```

Two of those fields are corrections to an earlier draft of this document, and
both are worth naming because the draft was wrong in a way that would have
shipped.

`sleep_seconds` **must be 32 bits.** `PROV_SLEEP_SECONDS_MAX` is 86,400 — a
legal, API-settable interval — and a `uint16_t` tops out at 65,535. Had the code
followed this document, every interval between 18.2 and 24 hours would have
wrapped silently on the way into RTC memory, and a board asked to poll once a day
would have woken every few hours instead, drawing several times the charge its
owner had asked for, with nothing anywhere to say so.

The field is `last_ok_unix`, not the `last_sntp_unix` this document first
sketched. Deep sleep does not lose the system clock — the RTC timer keeps it, so
once any boot has synced, later wakes know the time without help — so there was
nothing for a persisted SNTP timestamp to do. What the staleness arithmetic
actually needs is the last time a *poll* succeeded, which is a different quantity
the first sketch did not name.

**`magic` must incorporate the firmware build**, and this is not tidiness. If you
flash new rendering code onto a board holding an old `content_hash`, the first
wake computes the same hash from the same payload, concludes nothing changed, and
goes back to sleep — and **the new rendering never reaches the glass**, possibly
for months. It fails silently and it fails permanently. Mixing the build id into
`magic` turns a firmware change into a forced full path, once.

RTC memory does not survive a power-on reset, which is correct: a cold boot
should take the full path.

## 3. The decision is a pure function

This is the part that makes the design safe to ship. Everything else here is a
state machine that exists only on hardware and whose failures appear three days
later on a wall, in a room, with no serial cable attached.

```c
typedef enum {
    POWER_SLEEP_AGAIN,        /* nothing changed; back to sleep now */
    POWER_REFRESH_THEN_SLEEP, /* content moved; spend the one refresh */
    POWER_STAY_AWAKE,         /* button wake, portal, no cell, sleep disabled */
} power_action_t;

typedef struct {
    power_wake_t  wake;           /* COLD / TIMER / BUTTON */
    power_fetch_t fetch;          /* NOT_ATTEMPTED / UNCHANGED / CHANGED / FAILED */
    bool     rtc_valid;           /* magic matched */
    bool     sleep_enabled;       /* Kconfig + NVS */
    bool     battery_present;     /* board_io_battery_present() */
    bool     usb_console;         /* a developer is attached */
    bool     url_configured;
    uint16_t consecutive_fails;
    uint32_t base_sleep_seconds;
    uint32_t stale_seconds;
    uint32_t seconds_since_ok;
} power_input_t;

typedef struct {
    power_action_t action;
    uint32_t       sleep_seconds;   /* after backoff */
    uint16_t       next_fails;
} power_plan_t;

void power_decide(const power_input_t *in, power_plan_t *out);
```

**`power_wake_t` and `power_fetch_t` are hand-written mirrors, not the real
enums**, and that is the point rather than an inconvenience. An earlier draft of
this document typed those fields `esp_sleep_source_t` and `news_fetch_result_t`,
which would have pulled ESP-IDF and the whole of `news_model.h` into the one file
whose entire value is that it depends on neither. `main.cpp` owns the mapping and
is the only place that knows the IDF's spellings.

Pure, libm-free, and therefore the tenth host test: **`test_power_policy`**. It
pins the backoff curve, the `magic`-mismatch force, "no cell means never sleep",
and "a button wake always stays awake".

### What the pure function does and does not cover

The claim above is worth stating precisely, because a review found it overstated.
`power_decide()` settles the gates, the wake routing and the backoff. It does not
see a hash: by the time an outcome reaches it, the poll has already been
classified into `power_fetch_t`.

That classification is where the money is — it is what decides whether the panel
spends twenty-five seconds, and it also decides whether the ETag is recorded,
which is a rule this project has already got wrong once. So it is a second pure
function, `power_classify_fetch()`, tested beside the first, and `QuietFetch()`
in `main.cpp` is reduced to mapping `news_fetch_result_t` onto its arguments.
What remains untested on the device is that mapping and the I/O around it, which
is as small as it can be made.

### Backoff

A board pointed at a server that is switched off, or sitting on a Wi-Fi network
that no longer exists, must not keep its normal cadence — it would burn the cell
doing nothing, which is the failure this whole document exists to prevent. The
curve, held by `test_power_policy`:

| consecutive failures | sleep |
|---|---|
| 0 | the configured interval |
| 1–3 | the configured interval |
| 4–10 | 5× the interval |
| > 10 | 1 hour, capped |

The first failure that crosses `STALE_SECONDS` spends one refresh to badge the
sheet `OFFLINE`, sets `badge_offline`, and no failure afterwards spends another.
A reader needs to be told once. Telling them every hour costs 2.3 mAh a time to
repeat information the sheet already carries.

## 4. Shutdown checklist

`power_sleep()` is the only caller of `esp_deep_sleep_start()`, and it runs this
list first. Each item is a leak that would otherwise be invisible.

| item | why |
|---|---|
| GPIO43 (panel power) LOW | `epd6_refresh()` already powers the panel back down (`epd6_panel.h:102`), and the load switch has a pulldown, so a floating pin is off. Asserted anyway rather than assumed. |
| **GPIO6 (battery divider enable) LOW** | `board_io_init()` drives it HIGH and **nothing ever lowers it** (`board_io.c:50`). Left high across a sleep, the divider conducts from the cell continuously. This is a real bug the current firmware does not have symptoms for, because the board never sleeps. |
| `esp_wifi_stop()` | the radio must be down, not idle |
| EXT1 wake armed on GPIO 0/2/3/5 | `ESP_EXT1_WAKEUP_ANY_LOW`; all four buttons are RTC GPIOs on the S3 (RTC GPIOs are 0–21) |
| RTC timer armed | `esp_sleep_enable_timer_wakeup(plan.sleep_seconds * 1000000ULL)` |
| `awake_ms` accumulated | §9 |

`CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP=y` goes into
`sdkconfig.defaults`: it skips re-verifying the app image on a deep-sleep wake,
which is the single largest fixed cost in a wake that is otherwise three seconds
long.

## 5. The wire: ETag and 304

The user asked for the server half, and this is it. Two gates, and they are not
redundant — they save different things.

| gate | lives | saves |
|---|---|---|
| **ETag / 304** | server | the payload transfer, the cJSON tree, the 32 KB struct fill |
| **`news_hash()`** | device | **the 25-second refresh** — and it remains the sole authority |

`tools/mock_news_server.py` gains `ETag: "<sha256(canonical json)[:16]>"` on
`/news.json`, and answers `304 Not Modified` with no body when `If-None-Match`
matches. The device treats the tag as an **opaque string** and never interprets
it. The desk server uses the same recipe over the bytes it actually serves, so
its tag moves when the spliced `policy` block does — see
[docs/desk-server.md](../desk-server.md).

**Why both.** `news_hash()` fingerprints the *parsed model* — what reaches the
glass. The ETag fingerprints the *document*. They disagree exactly when a
producer changes a field the sheet does not render: `generated_at` moving on
every poll would change the ETag and not the hash. On that poll the server sends
200, the device parses, `news_hash()` says nothing moved, and the panel stays
still. The ETag is an optimisation layered over the existing rule; it does not
replace it, and it is not permitted to.

**Why the server cannot just send `news_hash()`.** It hashes a C struct after
parsing and clamping. Reimplementing it in Python means a second copy of a subtle
field-ordered algorithm to keep in sync forever — the project already carries one
such coupling (`news_mock.c` ↔ `mock_news_server.py`, enforced by
`test_news_mock`) and it is enough.

### The port seam

`http_get()` currently returns `NULL` for a transport failure. A 304 has no body,
so it would also return `NULL` and be misread as "the network is down" —
triggering backoff on the single most common successful outcome. That is a real
trap, so the conditional GET gets its own explicit shape rather than overloading
the existing one:

```c
typedef struct { const char *if_none_match; }  http_req_t;   /* NULL = plain GET */
typedef struct {
    int    status;                 /* 0 means transport failure */
    char  *body;                   /* NULL on 304 and on failure; caller frees */
    size_t len;
    char   etag[HTTP_ETAG_MAX];    /* "" when the server sent none */
} http_resp_t;

bool http_get_cond(const char *url, const http_req_t *req, http_resp_t *out);
```

`http_get()` and `http_get_bin()` stay exactly as they are, reimplemented on top
of this, so `ui_tile.c` and the photograph path are untouched. On the device this
needs `HTTP_EVENT_ON_HEADER` added to `on_evt()` (it currently handles only
`HTTP_EVENT_ON_DATA`) and one `esp_http_client_set_header()`. On the simulator it
is two libcurl options.

`news_service.h` gains `NEWS_FETCH_NOT_MODIFIED`, which is a **success**, and
every switch over the enum is updated — notably `s_online` must not be cleared by
it.

`mock_news_server.py` also gains `--no-etag`, because a board pointed at a server
with no conditional-GET support has to keep working, and that is a behaviour
worth being able to test on purpose.

## 6. The interval: three layers, and the desk above them

The same shape `news_url` already has, for the same reason.

| layer | where | changed by |
|---|---|---|
| **the desk's `policy` block** | the payload, per poll | the server, per its own schedule |
| `CONFIG_CLAUDEPOST_SLEEP_SECONDS` | Kconfig, default 900 | reflashing |
| `prov_config_t.sleep_seconds` | NVS, via the captive portal form | a phone |
| `POST /api/sleep {"seconds": 1800}` | runtime, persisted to NVS | a phone |

Taking a frame off a wall and finding a USB-C cable in order to change a polling
interval is the thing that will be resented within a month, which is why the
lower three exist. The value in force among them is copied into
`wp_rtc_state.sleep_seconds` so a change made over the API survives into the next
wake without an NVS read on the quiet path.

**The desk outranks all three, and the three are the fallback.** That is the
2026-08-24 change at the head of this document, and the reason is that the awake
poll loop had already obeyed `policy.poll_seconds` since the desk shipped. A
sleeping board that did not would be the same board following two different rules
depending on which power mode it happened to be in — one of them set by a server
that knows about its own quiet window and its own publishing schedule, the other
by a number somebody typed into a form months ago. The desk also names the
instant its answer will change (`next_change`), which becomes a targeted wake: a
board on an hourly overnight cadence still catches the 06:00 edition at 06:00.
One function resolves the lot — `power_cadence()` in `power_policy.c`, pure and
host-tested, called by the quiet path, by `enter_sleep()` and by the awake poll
loop — and the local layers are consulted when a payload carries no `policy` at
all: a file on a static host, or a mock without the block.

`CONFIG_CLAUDEPOST_DEEP_SLEEP` is a separate bool and **defaults to on**. The
argument for opt-in was that a sleeping board is a board you cannot reach; what
answers it is that this switch is not what decides. Three runtime gates disable
sleep whatever it says — no cell fitted, a USB console attached, no news URL —
and a board at a bench satisfies at least one of them permanently while a board
on a wall satisfies none. So off-by-default protects only the case the gates
already protect, and costs the case they do not: a frame hung up by somebody who
never found the menu entry, flat in two days.

## 7. Getting back in

A board awake for three seconds every fifteen minutes is a board you cannot
reach. Four layers, because this is the failure mode that turns a frame into a
brick.

1. **KEY2 held 5 s → AP portal.** GPIO 0/2/3/5 are all RTC GPIOs, so `ext1`
   wakes on any of them. **But the hold detection currently lives inside `UiTask`
   (`user_app.cpp:472`), which under deep sleep may never run.** It moves to the
   top of the full path, checked against the wake cause. This is not optional —
   without it the documented escape hatch stops working the day deep sleep ships.
2. **No cell → never sleep.** `board_io_battery_present()` false (USB power, no
   battery fitted) means `POWER_STAY_AWAKE` unconditionally. Development,
   flashing and monitoring behave exactly as they do today.
3. **USB console attached → never sleep.** The console is on USB Serial/JTAG
   (`sdkconfig.defaults`), so `usb_serial_jtag_is_connected()` answers "is a
   developer watching". A board that sleeps mid-`idf.py monitor` is a board
   nobody can debug.
4. **Backoff** (§3), so a board that cannot reach its server degrades to one wake
   an hour instead of burning the cell at full cadence.

## 8. The button wake keeps the companion app alive

A TIMER wake sleeps again immediately. An **EXT1 wake means a person is standing
in front of the frame**, so the full path stays up for `AWAKE_WINDOW_SECONDS`
(120) with `device_api` and mDNS serving, then sleeps.

About 2.8 mAh per press, incurred only when someone presses. The standing cost is
zero. Without this the companion app is effectively dead on a sleeping board —
it can never win the race against a three-second window.

## 9. The board measures itself

The two numbers this design rests on are both unmeasured: **deep-sleep current**
(the XIAO is specified at 14 µA, forum reports range from 9 µA to several hundred,
and the EE04's own ETA6003 / ETA3410 / TPS22916 contribution is unpublished) and
**Wi-Fi connect time** (the dominant term in a quiet wake).

So the board records them. Each wake accumulates `awake_ms` into RTC memory
alongside `wakes` and `quiet_wakes`, and `GET /api/state` reports the mean awake
time and an estimated daily draw derived from it. After a day on the wall, with
no instruments at all, the estimates in §10 become measurements. `docs/bring-up.md`
gains a row for recording them, next to `panel.refreshMs`.

## 10. What it should buy

Established constants: **0.023 mAh per awake second**, **2.3 mAh per refresh**
(both derived from measured wattage; battery mA ≈ W × 270 at 3.7 V).

A quiet wake is boot 0.3 s + Wi-Fi connect 1.5–3 s + conditional GET 0.2 s ≈
**0.08–0.15 mAh**. On a 4200 mAh cell, assuming two content changes a day:

| interval | wakes/day | mAh/day | lasts |
|---|---|---|---|
| always on (today) | — | 1944 | **2.2 days** |
| 1 min | 1440 | 150–160 | 26–28 days |
| 5 min | 288 | 35–41 | 100–120 days |
| **15 min** | 96 | 16–22 | **190–260 days** |
| 30 min | 48 | 11–17 | 250–380 days |
| 60 min | 24 | 8–14 | 300–520 days |

**The knee is 15–30 minutes.** Past it, deep-sleep current and the refreshes
dominate and lengthening the interval buys progressively less.

These are estimates with two unmeasured terms in them, and they are stated as
ranges for that reason. If deep-sleep current turns out to be 300 µA rather than
40, the 15-minute row becomes 22–29 mAh/day. §9 exists to close this.

## 11. What changes

| file | change |
|---|---|
| `components/power/` **(new)** | `wp_rtc_state`, `power_decide()`, `power_sleep()` |
| `main/main.cpp` | the two-path boot — the largest structural change |
| `components/news_core/include/http_port.h` + both ports | `http_get_cond()` |
| `news_service.[ch]` | `NEWS_FETCH_NOT_MODIFIED`, ETag in/out |
| `user_app.cpp` | honour the plan; the awake window; KEY2 hold moves out |
| `provisioning` (`prov_config`, `prov_store`, portal form) | `sleep_seconds` |
| `device_api` | `POST /api/sleep`; power telemetry in `/api/state` |
| `Kconfig.projbuild` | `CLAUDEPOST_DEEP_SLEEP` (off), `CLAUDEPOST_SLEEP_SECONDS` (900) |
| `sdkconfig.defaults` | `CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP=y` |
| `tools/mock_news_server.py` | ETag, 304, `--no-etag` |
| `test/host/test_power_policy.c` **(new)** | the tenth host test |
| `provisioning/test/fake_idf/` **(new)** | a fake NVS, which brings `prov_store.c` under host test for the first time — see below |
| `provisioning/test/test_prov_store.c` **(new)** | what that fake is for, chiefly the backward-compatibility case |
| docs | `CLAUDE.md`, `bring-up.md`, `news-contract.md`, `app-control.md`, `pinout.md`, `tools/edition/PROMPT.md` |

Two of those rows were not in the first draft of this table and are here because
the work found them necessary rather than because it was planned.

The fake NVS exists because `prov_store.c` had no host test at all, and this
change adds a field to a **persisted** struct. The case that had to be provable
is a board already hanging on a wall: a firmware update that added `sleep_seconds`
must not push it back into the captive portal to ask for a Wi-Fi password it has
had for months. That is not a claim worth making without a test, and the test is
not worth much against a stub — so the fake is a real key/value store, and the
suite went from 39 tests and 83 checks to 56 and 140.

`tools/edition/PROMPT.md` is the producer's instructions, and it needed the
`generated_at` warning far more than the firmware documents did: the producing
agent is the only party that can trigger that failure, and it was documented
everywhere except where that agent reads.

## 12. What this deliberately does not do

- **No OTA.** Tempting once the board is on a wall, and a separate project with
  its own failure modes. USB stays the update path.
- **No external RTC and no 32.768 kHz crystal.** The S3's internal RTC timer
  performs the wake; RC_SLOW drift (~0.6 %) is ±4 s on a 15-minute sleep and
  irrelevant, and wall-clock time is re-derived from SNTP or the HTTP `Date:`
  header on any wake that refreshes. GPIO15/16 are not broken out on the XIAO
  anyway.
- **No push wake.** LoRa or an always-listening radio was considered; it means
  more hardware, and a 15-minute worst-case latency on a *newspaper* is not a
  problem worth new silicon.
- **No PSRAM power-down on the quiet path.** Octal PSRAM is brought up by the
  startup code and its idle draw is a real but secondary term. Worth revisiting
  once §9 says what it costs; not worth a second build configuration now.
- **No partial-refresh anything.** There is still no partial waveform.

## 13. Verification

The existing four layers, plus one:

1. **Host tests — now ten.** `test_power_policy` joins the nine. The wake
   decision, the backoff curve, the `magic` force and the safety gates are all
   pure and all covered without hardware.
2. **`mock_news_server.py --check`**, plus a new conditional-GET round trip
   asserting 304-on-match, 200-on-change, and correct behaviour under `--no-etag`.
3. **Simulator** — unchanged; it never sleeps, and the rendering path is not
   touched by this work.
4. **`idf.py build`.**
5. **On hardware, and only here:** the wake actually happening, the quiet path
   costing no refresh, and the two numbers in §9. The bring-up document gains a
   row for each.

The honest statement is that layers 1–4 can prove the *policy* is right and can
prove nothing at all about the *current*. §9 is how that gap gets closed, by the
board, on the wall, without instruments.
