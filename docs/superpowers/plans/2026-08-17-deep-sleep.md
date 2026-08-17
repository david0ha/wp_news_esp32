# Deep Sleep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the board a wake path that polls, compares, and goes back to sleep without ever powering the panel — taking it from ~2 days on a cell to months.

**Architecture:** The boot splits in two. A *quiet path* (RTC-timer wake) brings up Wi-Fi from NVS, does a conditional GET, and sleeps again if nothing moved — never touching GPIO43, LVGL, or the 960 KB framebuffer. A *full path* (cold boot, button, or changed content) does what the firmware does today and then sleeps. The decision between them is a pure function with a host test.

**Tech Stack:** ESP-IDF v5.4.3, FreeRTOS, LVGL 9, cJSON (vendored), CMake host tests (plain C, no framework — see `components/news_core/test/host/th.h`), Python 3 stdlib for the reference server.

**Spec:** [`docs/specs/2026-08-17-deep-sleep-design.md`](../../specs/2026-08-17-deep-sleep-design.md)

## Global Constraints

Copied verbatim from `CLAUDE.md` and the spec. Every task's requirements include these.

- **`sdkconfig` is gitignored and per-developer — never commit it.** Kconfig defaults go in `components/*/Kconfig.projbuild`; shared build settings go in `sdkconfig.defaults`.
- **`news_hash()` is the sole authority on whether the panel moves.** The ETag saves the transfer and the parse. It never decides a refresh.
- **A rejected payload must leave the previous snapshot alone.** `news_parse()` writes `*out` only on success. Do not weaken this.
- **`news_mock.c` and `tools/mock_news_server.py` must stay identical**, asserted by `test_news_mock`. If a change to the server alters the *payload*, run `python3 tools/mock_news_server.py --write-fixture`. Adding response *headers* does not alter the payload.
- **Never hand-edit `components/news_core/fonts/*.c`.**
- **Every column span and every origin is EVEN** (not touched by this work, but do not break the `_Static_assert` in `ui_internal.h`).
- **No `float`/`double` in anything that decides where ink goes.** The power policy is integer-only for the same reason: it is host-tested and must agree between x86 and Xtensa exactly.
- **All fixed user-visible strings belong in `ui_strings.h`.**
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

**Verification command (run after every task that touches C):**

```bash
cmake -S components/news_core/test/host -B /tmp/dsleep && cmake --build /tmp/dsleep
```

**Full suite (run before the final commit):**

```bash
cmake -S components/news_core/test/host -B /tmp/dsleep && cmake --build /tmp/dsleep
/tmp/dsleep/test_news_parse && /tmp/dsleep/test_news_mock && /tmp/dsleep/test_news_service \
  && /tmp/dsleep/test_api_json && /tmp/dsleep/test_palette && /tmp/dsleep/test_epd6_transpose \
  && /tmp/dsleep/test_fit && /tmp/dsleep/test_chart_scale && /tmp/dsleep/test_compose \
  && /tmp/dsleep/test_power_policy
sh components/provisioning/test/run.sh
python3 tools/mock_news_server.py --check
cd sim && ./sim.sh && cd ..
. ~/esp/v5.4.3/esp-idf/export.sh && idf.py build
```

---

## File Structure

| file | responsibility |
|---|---|
| `components/power/include/power_policy.h` | **pure**, no ESP-IDF: the wake decision's types and `power_decide()` / `power_backoff_seconds()` |
| `components/power/power_policy.c` | **pure**: the decision itself. Host-tested. |
| `components/power/include/power.h` | device: RTC-retained state, `power_sleep()`, the Kconfig accessors |
| `components/power/power.c` | device: `RTC_DATA_ATTR` state, GPIO shutdown, `esp_deep_sleep_start()` |
| `components/power/Kconfig.projbuild` | `WP_NEWS_DEEP_SLEEP`, `WP_NEWS_SLEEP_SECONDS`, `WP_NEWS_AWAKE_WINDOW_SECONDS` |
| `components/power/CMakeLists.txt` | IDF component registration |
| `components/news_core/test/host/test_power_policy.c` | the tenth host test |
| `components/news_core/include/http_port.h` | + `http_get_cond()`, `http_req_t`, `http_resp_t`, `HTTP_ETAG_MAX` |
| `components/news_core/http_port_esp.c` | device impl of the above |
| `sim/http_port_curl.c` | host impl of the above |
| `components/news_core/include/news_service.h` | + `NEWS_FETCH_NOT_MODIFIED`, + `news_service_fetch_cond()` |
| `components/news_core/news_service.c` | the conditional fetch |
| `tools/mock_news_server.py` | ETag, 304, `--no-etag` |
| `components/provisioning/prov_config.h` | + `sleep_seconds`, + `prov_clamp_sleep_seconds()` |
| `components/provisioning/prov_store.c` | persist `sleep_seconds` |
| `components/provisioning/prov_portal.c` | the form field |
| `main/main.cpp` | the two-path boot |
| `components/user_app/user_app.cpp` | honour the plan; the awake window; KEY2 hold moves out |
| `components/device_api/*` | `POST /api/sleep`, power telemetry in `/api/state` |

Tasks 1–4 touch disjoint files and may run in parallel. Tasks 5–8 integrate and are sequential.

---

### Task 1: The wake decision, as a pure function

**Files:**
- Create: `components/power/include/power_policy.h`
- Create: `components/power/power_policy.c`
- Create: `components/news_core/test/host/test_power_policy.c`
- Modify: `components/news_core/test/host/CMakeLists.txt` (append a block, mirroring the `test_compose` block at lines 88–91)

**Interfaces — Produces** (later tasks depend on these names exactly):

```c
typedef enum {
    POWER_WAKE_COLD = 0,    /* power-on, reset, or any cause we do not act on */
    POWER_WAKE_TIMER,       /* the RTC timer fired — a scheduled poll */
    POWER_WAKE_BUTTON,      /* ext1 on KEY0/1/2/BOOT — a person is present */
} power_wake_t;

typedef enum {
    POWER_FETCH_NOT_ATTEMPTED = 0, /* no URL, or Wi-Fi never came up */
    POWER_FETCH_UNCHANGED,         /* 304, or 200 whose news_hash() matched */
    POWER_FETCH_CHANGED,           /* 200 carrying something new */
    POWER_FETCH_FAILED,            /* transport, bad status, or bad payload */
} power_fetch_t;

typedef enum {
    POWER_SLEEP_AGAIN = 0,         /* sleep now; the panel is not touched */
    POWER_REFRESH_THEN_SLEEP,      /* print, then sleep */
    POWER_STAY_AWAKE,              /* do not sleep at all — today's behaviour */
} power_action_t;

typedef struct {
    power_wake_t  wake;
    power_fetch_t fetch;
    bool     rtc_valid;            /* magic matched: we know what is on the glass */
    bool     sleep_enabled;        /* Kconfig && NVS */
    bool     battery_present;
    bool     usb_console;          /* a developer is attached */
    bool     url_configured;
    bool     offline_badged;       /* the reader has already been told */
    uint16_t consecutive_fails;    /* BEFORE this wake */
    uint32_t base_sleep_seconds;
    uint32_t stale_seconds;
    uint32_t seconds_since_ok;     /* 0 when never */
} power_input_t;

typedef struct {
    power_action_t action;
    uint32_t       sleep_seconds;  /* after backoff */
    uint16_t       next_fails;
    bool           badge_offline;  /* spend this one refresh saying so */
} power_plan_t;

#define POWER_BACKOFF_MAX_SECONDS 3600u

void     power_decide(const power_input_t *in, power_plan_t *out);
uint32_t power_backoff_seconds(uint32_t base, uint16_t fails);
const char *power_action_name(power_action_t a);   /* "sleep" / "refresh" / "awake" */
```

**Consumes:** nothing. This task is a leaf.

- [ ] **Step 1: Write the failing test.**

`test_power_policy.c` follows `test_news_service.c`'s shape exactly: `#include "th.h"`, file-static input, `CHECK` / `CHECK_INT` / `CHECK_STR`, `TH_REPORT("power_policy")` in `main`. Include a file-header comment in the house style saying *why* this test exists — that the alternative to a pure policy is a state machine that only fails after three days on a wall with no serial cable attached.

Cases, each its own `static void test_*(void)`:

| test | asserts |
|---|---|
| `test_safety_gates_beat_everything` | each of `!sleep_enabled`, `!battery_present`, `usb_console`, `!url_configured` alone forces `POWER_STAY_AWAKE`, even with `wake=TIMER, fetch=UNCHANGED` |
| `test_a_button_wake_stays_awake` | `POWER_WAKE_BUTTON` ⇒ `STAY_AWAKE` regardless of fetch outcome |
| `test_a_cold_boot_always_prints` | `POWER_WAKE_COLD` ⇒ `REFRESH_THEN_SLEEP`, and `next_fails == 0` |
| `test_stale_rtc_state_forces_a_print` | `wake=TIMER, rtc_valid=false, fetch=UNCHANGED` ⇒ `REFRESH_THEN_SLEEP`. **This is the new-firmware case: without it, changed rendering code never reaches the glass.** |
| `test_unchanged_content_sleeps_without_a_refresh` | `wake=TIMER, rtc_valid, fetch=UNCHANGED` ⇒ `SLEEP_AGAIN`, `sleep_seconds == base`, `next_fails == 0`, `badge_offline == false` |
| `test_changed_content_earns_the_refresh` | `fetch=CHANGED` ⇒ `REFRESH_THEN_SLEEP`, `next_fails == 0` |
| `test_a_failure_sleeps_and_counts` | `fetch=FAILED`, fresh snapshot ⇒ `SLEEP_AGAIN`, `next_fails == consecutive_fails + 1` |
| `test_offline_is_badged_once_and_only_once` | `fetch=FAILED, seconds_since_ok > stale_seconds, offline_badged=false` ⇒ `REFRESH_THEN_SLEEP` **and** `badge_offline == true`; the same input with `offline_badged=true` ⇒ `SLEEP_AGAIN`, `badge_offline == false` |
| `test_the_backoff_curve` | `power_backoff_seconds(900, n)` is `900` for n ∈ {0,1,2,3}, `4500` for n ∈ {4,…,10} — **capped to 3600** — and `3600` for n = 11, 100, 65535 |
| `test_backoff_never_shortens_a_configured_sleep` | `power_backoff_seconds(7200, 50) == 7200`. A user who asked for two hours keeps two hours even though the cap is one. |
| `test_the_fail_counter_saturates` | `consecutive_fails = 65535, fetch=FAILED` ⇒ `next_fails == 65535`, no wraparound to 0 (a wrap would silently reset the backoff) |
| `test_not_attempted_is_treated_as_a_failure` | `fetch=POWER_FETCH_NOT_ATTEMPTED` with `url_configured=true` behaves as `FAILED` — Wi-Fi that never came up is a failure, not a success |
| `test_action_names_are_stable` | `power_action_name()` for all three plus an out-of-range value ⇒ `"unknown"` |

- [ ] **Step 2: Run it and watch it fail.**

```bash
cmake -S components/news_core/test/host -B /tmp/dsleep && cmake --build /tmp/dsleep
```
Expected: a compile failure — `power_policy.h: No such file or directory`.

- [ ] **Step 3: Write the minimal implementation.**

`power_policy.c`. Decision order matters and the comments must say why:

```c
void power_decide(const power_input_t *in, power_plan_t *out)
{
    out->action        = POWER_STAY_AWAKE;
    out->sleep_seconds = in->base_sleep_seconds;
    out->next_fails    = in->consecutive_fails;
    out->badge_offline = false;

    /* The safety gates come first and they are absolute. Each one is a way a
     * board becomes unreachable: sleeping while a developer is watching the
     * monitor, sleeping on USB with no cell to save, or sleeping with no URL to
     * poll — a demo board that wakes every fifteen minutes to fetch nothing. */
    if (!in->sleep_enabled || !in->battery_present || in->usb_console ||
        !in->url_configured) {
        return;
    }

    /* A button woke us, so a person is standing in front of the frame. Staying
     * up costs 0.023 mAh a second and is incurred only when someone presses;
     * the standing cost is zero, and without it the companion app can never win
     * the race against a three-second window. */
    if (in->wake == POWER_WAKE_BUTTON) {
        return;
    }

    /* A cold boot has nothing on the glass it can vouch for. So does a wake
     * whose RTC magic did not match, which is how a firmware update announces
     * itself: the old content_hash would otherwise match the new build's hash
     * of the same payload, and the changed rendering would never be printed. */
    if (in->wake == POWER_WAKE_COLD || !in->rtc_valid) {
        out->action     = POWER_REFRESH_THEN_SLEEP;
        out->next_fails = 0;
        return;
    }

    switch (in->fetch) { /* ... as specified in the tests ... */ }
}
```

`power_backoff_seconds()` is integer-only and clamps in this order: apply the curve, cap at `POWER_BACKOFF_MAX_SECONDS`, then take `max(result, base)` so a configured sleep longer than the cap survives.

- [ ] **Step 4: Run the tests and watch them pass.**

```bash
cmake --build /tmp/dsleep && /tmp/dsleep/test_power_policy
```
Expected: `power_policy: N/N checks passed`.

- [ ] **Step 5: Commit.**

```bash
git add components/power/ components/news_core/test/host/test_power_policy.c \
        components/news_core/test/host/CMakeLists.txt
git commit -m "feat(power): the wake decision, as a pure function"
```

---

### Task 2: Conditional GET, through the port seam and the fetch layer

**Files:**
- Modify: `components/news_core/include/http_port.h`
- Modify: `components/news_core/http_port_esp.c`
- Modify: `sim/http_port_curl.c`
- Modify: `components/news_core/include/news_service.h`
- Modify: `components/news_core/news_service.c`
- Modify: `components/news_core/test/host/test_news_service.c`

**Interfaces — Produces:**

```c
/* http_port.h */
#define HTTP_ETAG_MAX 64

typedef struct {
    const char *if_none_match;   /* NULL or "" = an unconditional GET */
} http_req_t;

typedef struct {
    int    status;               /* 0 means the transport failed */
    char  *body;                 /* NULL on 304 and on failure; caller frees */
    size_t len;
    char   etag[HTTP_ETAG_MAX];  /* "" when the server sent none */
} http_resp_t;

/* Returns false only on transport failure (out->status == 0). A 304 is a
 * SUCCESS with a NULL body — which is why this exists rather than another
 * overload of http_get(), whose NULL return cannot tell the two apart. */
bool http_get_cond(const char *url, const http_req_t *req, http_resp_t *out);

/* news_service.h */
NEWS_FETCH_NOT_MODIFIED,   /* the server says the content is unchanged (304) */

news_fetch_result_t news_service_fetch_cond(const char *url,
                                            const char *if_none_match,
                                            news_t *out,
                                            char *out_etag, size_t etag_size);
```

**Consumes:** nothing from other tasks.

**The trap this task exists to close:** `http_get()` returns `NULL` for a transport failure *and* for a bodyless 304. Under deep sleep, 304 is the single most common successful outcome, and misreading it as a transport failure would drive the backoff curve on every healthy poll. Do not fix this by sentinel-checking the status inside `http_get()` — give the conditional request its own explicit shape and leave `http_get()` / `http_get_bin()` byte-for-byte compatible for `ui_tile.c`.

- [ ] **Step 1: Write the failing tests.**

Add to `test_news_service.c`. The file already *is* the HTTP port (it defines `http_get`), so it now also defines `http_get_cond`, driven by new file-statics `g_etag_in` (what the fake server saw), `g_etag_out`, and `g_cond_status`.

New cases:

| test | asserts |
|---|---|
| `test_304_is_a_success_not_a_failure` | a 304 with a NULL body ⇒ `NEWS_FETCH_NOT_MODIFIED`, **not** `NEWS_FETCH_TRANSPORT` |
| `test_304_leaves_the_snapshot_untouched` | `news_hash(&g_v)` before == after |
| `test_the_stored_etag_is_sent` | the fake port records `if_none_match`; passing `"abc"` makes it arrive as `"abc"`; passing `NULL` or `""` sends nothing |
| `test_a_200_reports_the_new_etag` | `out_etag` receives the server's tag; a server that sends none leaves `out_etag[0] == '\0'` |
| `test_the_etag_is_truncated_safely` | a 200-character ETag from a hostile server lands NUL-terminated within `HTTP_ETAG_MAX`, no overrun (build the test binary with `-DSANITIZE=ON` to prove it) |
| `test_a_failed_fetch_does_not_clobber_the_etag` | `out_etag` is untouched on `TRANSPORT` / `HTTP_STATUS` / `BAD_PAYLOAD`, exactly as `*out` is |
| `test_result_names_are_stable` (extend) | `news_fetch_result_name(NEWS_FETCH_NOT_MODIFIED) == "not_modified"` |

Also extend `test_the_whole_2xx_range_is_accepted` to prove **304 is not in the 2xx range and is still a success**, and that 301/302 remain `NEWS_FETCH_HTTP_STATUS` — a captive portal redirect must not be mistaken for "unchanged".

- [ ] **Step 2: Run and watch it fail.**

```bash
cmake --build /tmp/dsleep 2>&1 | head -20
```
Expected: `unknown type name 'http_req_t'`.

- [ ] **Step 3: Implement.**

Three implementations of one seam:

1. **`http_port.h`** — the types above, with a comment on `http_resp_t.body` stating the NULL-on-304 contract explicitly.
2. **`http_port_esp.c`** — `on_evt()` currently early-returns on anything that is not `HTTP_EVENT_ON_DATA` (line 50). Add a `HTTP_EVENT_ON_HEADER` arm that case-insensitively matches `ETag` and `strlcpy`s the value into the accumulator. Send the request header with `esp_http_client_set_header(t_client, "If-None-Match", req->if_none_match)` — and **clear it with `esp_http_client_delete_header()` when there is none**, because the client handle is reused across calls and a stale header would make every subsequent unconditional GET conditional. Re-express `http_get_bin()` in terms of the new function so there is one transport path, not two.
3. **`http_port_curl.c`** — `CURLOPT_HEADERFUNCTION` for the ETag, `CURLOPT_HTTPHEADER` for `If-None-Match`. libcurl reports 304 through `CURLINFO_RESPONSE_CODE` with `CURLE_OK` and no body, which is exactly the contract.
4. **`news_service.c`** — `news_service_fetch_cond()`; keep `news_service_fetch()` as a one-line wrapper passing `NULL` so nothing else changes. Status order stays: transport → 304 → non-2xx → parse.

- [ ] **Step 4: Run and watch them pass.** Then **grep every switch over `news_fetch_result_t`** and handle the new value — at minimum `news_fetch_result_name()`, `user_app.cpp`'s `s_online` assignment (a 304 must **not** clear `s_online`), and `device_api`'s `lastResult`. A `-Wswitch` warning is the build telling you where.

```bash
cmake --build /tmp/dsleep && /tmp/dsleep/test_news_service
```

- [ ] **Step 5: Commit.**

```bash
git add components/news_core sim/http_port_curl.c
git commit -m "feat(http): a conditional GET whose 304 is not a transport failure"
```

---

### Task 3: The reference producer answers 304

**Files:**
- Modify: `tools/mock_news_server.py` (`Handler.do_GET`, lines 964–1013; `main()`, lines 1574–1643)
- Create: `tools/test_mock_etag.py`

**Interfaces — Produces:** the wire behaviour Task 2's device half talks to. No C symbols.

**Consumes:** nothing.

- [ ] **Step 1: Write the failing test.**

`tools/test_mock_etag.py` — stdlib only (`unittest`, `http.client`, `threading`), starting the real `Handler` on an ephemeral port. Assert:

- a plain `GET /news.json` returns 200 **and** an `ETag` header
- the same GET with `If-None-Match: <that etag>` returns **304** with `Content-Length: 0` and an empty body
- `If-None-Match: "something-else"` returns 200 with the full payload
- the ETag is **stable across requests** when the payload is (this is the whole contract; a timestamp in the tag would refresh the panel every poll)
- with `--live`, the ETag **changes** when the payload does
- with `Handler.etag_enabled = False`, no `ETag` header is sent and `If-None-Match` is ignored — a board pointed at a server without conditional-GET support must keep working
- `/tiles/*.bin` is unaffected

- [ ] **Step 2: Run and watch it fail.**

```bash
python3 tools/test_mock_etag.py
```
Expected: `AssertionError: no ETag header`.

- [ ] **Step 3: Implement.**

In `Handler`, add `etag_enabled = True` and a helper computing `'"' + hashlib.sha1(canonical).hexdigest()[:16] + '"'` where `canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()`. **Compute it from the payload object, never from the response bytes** — `ensure_ascii` and key order are formatting, and a tag that moves when formatting moves would refresh the panel for nothing.

Send `ETag` on every 200. When `If-None-Match` matches, `send_response(304)`, `Content-Length: 0`, `Connection: keep-alive`, `end_headers()`, and **write no body**. Add `--no-etag` to `main()` setting `Handler.etag_enabled = False`.

This changes headers only, so the payload and the committed fixture are untouched.

- [ ] **Step 4: Run and watch them pass.**

```bash
python3 tools/test_mock_etag.py && python3 tools/mock_news_server.py --check
```
Expected: both pass, `--check` still reporting the fixture matches.

- [ ] **Step 5: Commit.**

```bash
git add tools/mock_news_server.py tools/test_mock_etag.py
git commit -m "feat(mock server): an ETag the device can ask about"
```

---

### Task 4: The interval, through provisioning

**Files:**
- Modify: `components/provisioning/prov_config.h`, `prov_config.c`
- Modify: `components/provisioning/prov_store.c`
- Modify: `components/provisioning/prov_portal.c` (the setup form and `POST /api/provision`)
- Modify: `components/provisioning/test/` — the existing pure suite (`sh components/provisioning/test/run.sh`)

**Interfaces — Produces:**

```c
/* prov_config.h */
#define PROV_SLEEP_SECONDS_MIN   60u
#define PROV_SLEEP_SECONDS_MAX 86400u
#define PROV_SLEEP_SECONDS_UNSET 0u   /* "use the build-time default" */

/* inside prov_config_t, appended — never inserted, the struct is persisted */
uint32_t sleep_seconds;

/* 0 passes through as UNSET; anything else is clamped into [MIN, MAX]. */
uint32_t prov_clamp_sleep_seconds(uint32_t seconds);
```

**Consumes:** nothing.

- [ ] **Step 1: Write the failing test.**

In the provisioning host suite, mirroring how `prov_validate_news_url` is tested:

| test | asserts |
|---|---|
| clamping | `0 → 0` (unset), `1 → 60`, `59 → 60`, `60 → 60`, `900 → 900`, `86400 → 86400`, `86401 → 86400`, `UINT32_MAX → 86400` |
| round trip | a config with `sleep_seconds = 1800` saves and loads back as `1800` |
| **backward compatibility** | a config written by the *previous* firmware (no `sleep_seconds` key in NVS) loads with `sleep_seconds == PROV_SLEEP_SECONDS_UNSET`, and every other field intact. A board that is already provisioned must not be pushed back into the captive portal by a firmware update. |
| form parsing | the portal form field parses `"1800"` → 1800, `""` → UNSET, `"abc"` → UNSET (not 0-as-a-number, not a rejection of the whole form) |

- [ ] **Step 2: Run and watch it fail.**

```bash
sh components/provisioning/test/run.sh
```

- [ ] **Step 3: Implement.** Append the field (never insert — the struct is persisted). `prov_store_load()` treats a missing NVS key as `UNSET` rather than an error. The portal form gains one optional numeric input labelled from `ui_strings.h`; leaving it blank means "use the default".

- [ ] **Step 4: Run and watch them pass.**

```bash
sh components/provisioning/test/run.sh
```
Expected: the existing 39 tests still pass, plus the new ones.

- [ ] **Step 5: Commit.**

```bash
git add components/provisioning/
git commit -m "feat(provisioning): carry the sleep interval in NVS"
```

---

### Task 5: The device half — RTC state, Kconfig, and the shutdown

**Files:**
- Create: `components/power/include/power.h`, `components/power/power.c`
- Create: `components/power/CMakeLists.txt`, `components/power/Kconfig.projbuild`
- Modify: `sdkconfig.defaults`
- Modify: `components/board_io/board_io.h`, `board_io.c`

**Interfaces — Produces:**

```c
/* power.h */
typedef struct {
    uint32_t magic;
    uint32_t content_hash;
    char     etag[HTTP_ETAG_MAX];
    uint32_t sleep_seconds;
    uint16_t consecutive_fails;
    bool     offline_badged;
    uint32_t wakes;
    uint32_t quiet_wakes;
    uint32_t awake_ms_total;
    int64_t  last_ok_unix;
} wp_rtc_state_t;

power_wake_t   power_wake_cause(void);          /* maps esp_sleep_get_wakeup_cause() */
wp_rtc_state_t *power_state(void);              /* the RTC-retained struct */
bool           power_state_valid(void);         /* magic == WP_RTC_MAGIC ^ build id */
void           power_state_reset(void);
bool           power_usb_console_attached(void);
void           power_sleep(uint32_t seconds);   /* does not return */
```

**Consumes:** `power_wake_t` (Task 1), `HTTP_ETAG_MAX` (Task 2).

- [ ] **Step 1: The `board_io` leak, first, because it is a real bug.**

`board_io_init()` drives the battery divider enable HIGH (`board_io.c:50`) and **nothing ever lowers it**. Add:

```c
/* Drop the battery divider's load switch. The divider conducts from the cell
 * whenever this pin is high, and board_io_init() leaves it high forever — which
 * costs nothing on a board that never sleeps and is a standing drain on one
 * that does. Call this immediately before esp_deep_sleep_start(). */
void board_io_sleep(void);
```

Also correct `board_io.h`'s header comment, which currently claims "board_io_init() drives it and leaves it on; the divider's standing draw is a few microamps, which is nothing against a board whose panel is the interesting load" — true then, false the moment this ships.

- [ ] **Step 2: `power.c`.**

`RTC_DATA_ATTR wp_rtc_state_t s_state;` — RTC slow memory, retained across deep sleep, lost on power-on reset (which is what we want: a cold boot must print).

`WP_RTC_MAGIC ^ build id`: derive the build id from something that changes with the binary. Use `esp_app_get_description()->app_elf_sha256` folded into 32 bits. **A comment must state the consequence of getting this wrong**: a firmware update that keeps a matching hash means the new rendering never reaches the glass, silently, possibly for months.

`power_sleep()` runs the spec's §4 checklist in order, logging one line with the interval and the reason, then `esp_deep_sleep_start()`:

```c
epd6_sleep();                    /* belt-and-braces: epd6_refresh() already
                                  * powers the panel down, but a boot that
                                  * refreshed nothing never called it */
gpio_set_level(EPD_POWER_PIN, 0);
board_io_sleep();
esp_wifi_stop();
esp_sleep_enable_ext1_wakeup_io(BTN_WAKE_MASK, ESP_EXT1_WAKEUP_ANY_LOW);
esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
```

`BTN_WAKE_MASK` is `BIT(0)|BIT(2)|BIT(3)|BIT(5)` built from `user_config.h`'s button pins — **derived from them, not retyped**, so the pinout stays stated in one place. Add a `_Static_assert` that every wake pin is ≤ 21, which is the S3's RTC-GPIO ceiling; a pin above it fails to wake and reports nothing.

- [ ] **Step 3: Kconfig and `sdkconfig.defaults`.**

`components/power/Kconfig.projbuild`:

```
config WP_NEWS_DEEP_SLEEP
    bool "Sleep between polls (battery mode)"
    default n
```
The help text carries the numbers from the spec's §10 table and says plainly that it is off by default because a sleeping board is a board you cannot reach, and that it is additionally disabled at runtime with no cell fitted or a USB console attached.

```
config WP_NEWS_SLEEP_SECONDS
    int "Sleep between polls (seconds)"
    default 900
    range 60 86400
```
Help text: the knee is 15–30 minutes; past it, deep-sleep current and the refreshes dominate. NVS and `POST /api/sleep` both override this.

```
config WP_NEWS_AWAKE_WINDOW_SECONDS
    int "How long a button wake stays reachable (seconds)"
    default 120
```

Append to `sdkconfig.defaults`, with a comment explaining it is the largest fixed cost in a wake that is otherwise three seconds long:

```
CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP=y
```

- [ ] **Step 4: Build.**

```bash
. ~/esp/v5.4.3/esp-idf/export.sh && idf.py build
```
Expected: exit 0, no new warnings. (Nothing calls `power_sleep()` yet — that is Task 6.)

- [ ] **Step 5: Commit.**

```bash
git add components/power/ components/board_io/ sdkconfig.defaults
git commit -m "feat(power): RTC-retained state and a shutdown that closes the divider"
```

---

### Task 6: The two-path boot

**Files:**
- Modify: `main/main.cpp`
- Modify: `main/CMakeLists.txt` (add the `power` dependency)
- Modify: `components/provisioning/provisioning.h`, `provisioning.c`

**Consumes:** Tasks 1, 2, 4, 5.

**Produces:** `bool provisioning_connect_only(prov_config_t *out, uint32_t timeout_ms);` — a quiet connect that **never starts the portal and never emits an event**. On failure it returns false and leaves the radio down; the caller decides.

- [ ] **Step 1: `provisioning_connect_only()`.** Factor the `have_config && !forced` branch (`provisioning.c:144–151`) so both it and `provisioning_run()` use one connect. `provisioning_run()` keeps its exact current behaviour — the portal, the events, the infinite loop.

- [ ] **Step 2: Restructure `app_main`.** `epd6_init()` and `Lvgl_PortInit()` move behind the decision. The quiet path is guarded so that *any* doubt takes the full path.

The failure table from the spec's §1 is the contract, and it is the part to get right: **only "the content changed" falls through.** Everything else — Wi-Fi timeout, transport failure, non-2xx, rejected payload — counts a failure and sleeps. A board whose Wi-Fi has gone away must not start the captive portal on every wake; that is 2.3 mAh every fifteen minutes, about 220 mAh a day, flat in under three weeks while showing a setup screen nobody is looking at.

- [ ] **Step 3: Verify by reading, and say so.** There is no host test for `app_main`. Re-read the diff against the spec's §1 flow and the failure table, and confirm each row is implemented. This step's output is a written confirmation in the commit body, not a green tick.

- [ ] **Step 4: Build and run the whole suite.**

```bash
cmake --build /tmp/dsleep && for t in /tmp/dsleep/test_*; do "$t" || exit 1; done
sh components/provisioning/test/run.sh && python3 tools/mock_news_server.py --check
. ~/esp/v5.4.3/esp-idf/export.sh && idf.py build
```

- [ ] **Step 5: Commit.**

```bash
git add main/ components/provisioning/
git commit -m "feat(boot): a quiet path that never powers the panel"
```

---

### Task 7: `user_app` honours the plan

**Files:**
- Modify: `components/user_app/user_app.cpp`
- Modify: `components/user_app/CMakeLists.txt`

**Consumes:** Tasks 1, 5, 6.

- [ ] **Step 1: Move the KEY2 hold out of `UiTask`.** It currently lives at `user_app.cpp:472`, inside `handle_press()`, which under deep sleep may never run — **the documented escape hatch dies the day this ships unless it moves.** Add `bool user_app_check_force_ap_at_boot(const int *btn_gpios, int n)`, called from the full path before the UI is built: if the wake was `POWER_WAKE_BUTTON` and KEY2 is still down after `FORCE_AP_HOLD_MS`, set the force-portal flag and restart. `handle_press()` keeps its own check for the awake case.

- [ ] **Step 2: The awake window.** On `POWER_STAY_AWAKE` from a button wake, `UiTask` runs normally for `CONFIG_WP_NEWS_AWAKE_WINDOW_SECONDS` and then calls `power_sleep()`. Any command or button press **restarts** the window — a user mid-interaction must not be cut off. On `POWER_STAY_AWAKE` from a safety gate (no cell, USB console, sleep disabled), the window never closes: that is today's behaviour and it is what makes `idf.py monitor` usable.

- [ ] **Step 3: Publish the hash and ETag.** After a refresh, write `news_hash()` and the ETag into `power_state()` so the next quiet wake can compare. **This must happen after the refresh, not before** — a board that records the hash and then browns out mid-refresh would spend the next month convinced it had printed a page it had not.

- [ ] **Step 4: Telemetry.** Accumulate `awake_ms` into the RTC state on the way to sleep; increment `wakes` and `quiet_wakes`. This is the spec's §9 — the two unmeasured terms in the whole design become measurements after a day on a wall, without instruments.

- [ ] **Step 5: Build, run everything, commit.**

```bash
. ~/esp/v5.4.3/esp-idf/export.sh && idf.py build
git add components/user_app/
git commit -m "feat(app): an awake window for a button, and the hash the next wake compares"
```

---

### Task 8: The companion app can see and set it

**Files:**
- Modify: `components/device_api/*` (the handler table and `/api/state`)
- Modify: `components/news_core/device_api_json.c`, `components/news_core/include/device_api_model.h`
- Modify: `components/news_core/test/host/test_api_json.c`
- Modify: `components/user_app/user_app_api.h`, `user_app.cpp` (`user_app_snapshot`)
- Modify: `docs/app-control.md`

**Consumes:** Tasks 1, 4, 5, 7.

- [ ] **Step 1: Write the failing test** in `test_api_json.c`, following the existing style: `/api/state` gains a `power` object — `{ "sleepSeconds", "deepSleep": bool, "wakes", "quietWakes", "meanAwakeMs", "estMahPerDay" }` — and the serializer emits it with correct JSON escaping and no trailing comma when counts are zero.

`estMahPerDay` is computed integer-only from `meanAwakeMs` and the configured interval, using the spec's 0.023 mAh/awake-second. Assert the arithmetic on a worked example so the constant cannot drift silently.

- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement**, including `POST /api/sleep {"seconds": N}` → `prov_clamp_sleep_seconds()` → NVS → `power_state()->sleep_seconds`. Reject a non-integer body with 400 and a named error, as the other handlers do.
- [ ] **Step 4: Run and watch it pass.** Update `docs/app-control.md` in the same commit — it is the contract document, and a companion app written against a stale one is the failure this endpoint is for.
- [ ] **Step 5: Commit.**

```bash
git add components/device_api/ components/news_core/ components/user_app/ docs/app-control.md
git commit -m "feat(api): report the power budget and set the interval from a phone"
```

---

### Task 9: Documentation

**Files:** `CLAUDE.md`, `docs/bring-up.md`, `docs/news-contract.md`, `docs/pinout.md`

**Consumes:** everything.

- [ ] **Step 1: `CLAUDE.md`.** The "three things that make this board different" section gains the deep-sleep rule, phrased as the others are — as a constraint with its reason. The existing "A boot spends exactly one refresh" bullet extends to "and a wake that changes nothing spends none".
- [ ] **Step 2: `docs/bring-up.md`.** §4 "Record the numbers" gains rows for deep-sleep current and mean awake time, and says they now come from `GET /api/state`'s `power` object rather than from an instrument. Note that the board does not sleep with a USB console attached, so the boot log looks unchanged during bring-up — otherwise the first person to flash this will think the feature is broken.
- [ ] **Step 3: `docs/news-contract.md`.** The ETag and 304 half of the contract, and the statement that a server without conditional-GET support is fully supported and merely costs a parse.
- [ ] **Step 4: `docs/pinout.md`.** The four buttons are RTC GPIOs and are the ext1 wake sources; GPIO6 is now driven low before sleep.
- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md docs/
git commit -m "docs: what the board does when it is asleep"
```

---

## Self-Review

**Spec coverage.** §1 → Tasks 6, 7. §1's failure table → Task 6 Step 2. §2 → Task 5. §3 → Task 1. §4 → Task 5 Steps 1–2. §5 → Tasks 2, 3. §6 → Tasks 4, 5, 8. §7 → Tasks 1 (gates), 5 (Kconfig), 7 (KEY2). §8 → Task 7 Step 2. §9 → Tasks 7, 8. §11 → the file table. §13 → the verification commands.

**Type consistency.** `power_wake_t`, `power_fetch_t`, `power_action_t`, `power_input_t`, `power_plan_t`, `power_decide`, `power_backoff_seconds`, `POWER_BACKOFF_MAX_SECONDS` are defined once in Task 1 and used with those exact spellings in 5, 6, 7. `HTTP_ETAG_MAX`, `http_req_t`, `http_resp_t`, `http_get_cond` are defined in Task 2 and consumed in 5 (`wp_rtc_state_t.etag`) and 6. `prov_clamp_sleep_seconds` is defined in Task 4 and consumed in 8.

**One gap found and closed:** Task 2's `news_fetch_result_t` gains a value, and C will not warn about an unhandled case in a `switch` without `-Wswitch` on a covered enum. Task 2 Step 4 makes grepping every switch an explicit step rather than an assumption, and names the one that matters — a 304 must not clear `s_online`.
