// prov_store.c is not pure — it talks to NVS — but it is in this suite anyway,
// against the in-memory NVS in test/fake_idf/. The reason is one requirement
// that cannot be checked any other way: a board already hanging on a wall,
// provisioned by a firmware built before `sleep_seconds` existed, must survive
// the update. Its flash has no key for the new field, and the only honest test
// of what prov_store_load() does about that is to put flash in exactly that
// state and load it.
//
// The failure this guards against is quiet and total: if a missing key were
// read as an error, or counted against "is anything stored", every provisioned
// board in the field would come back from an update sitting in the captive
// portal asking for a Wi-Fi password again.
#include "tf.h"

#include <string.h>

#include "fake_nvs.h"
#include "prov_config.h"
#include "prov_store.h"

// The NVS key the interval is stored under. Named here as well as in
// prov_store.c on purpose — the backward-compatibility test's whole claim is
// about a key that is *absent*, and it can only assert that by naming it.
#define KEY_SLEEP "sleep_s"

static const char *const kUrl = "http://macbook.local:8123/news.json";

static void seed_a_provisioned_board(void)
{
    fake_nvs_seed_str("ssid", "Home");
    fake_nvs_seed_str("pass", "hunter2");
    fake_nvs_seed_str("vurl", kUrl);
}

TEST(store_reads_a_config_written_before_sleep_seconds_existed)
{
    fake_nvs_reset();
    seed_a_provisioned_board();
    CHECK(fake_nvs_has_key(KEY_SLEEP) == false);   // the previous firmware never wrote it

    prov_config_t cfg;
    CHECK(prov_store_load(&cfg) == true);          // still provisioned: no trip to the portal
    CHECK_STR(cfg.ssid, "Home");
    CHECK_STR(cfg.password, "hunter2");
    CHECK_STR(cfg.news_url, kUrl);
    CHECK_INT(cfg.sleep_seconds, PROV_SLEEP_SECONDS_UNSET);
}

TEST(store_round_trips_the_sleep_interval)
{
    fake_nvs_reset();

    prov_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    strcpy(cfg.ssid, "Home");
    strcpy(cfg.password, "hunter2");
    strcpy(cfg.news_url, kUrl);
    cfg.sleep_seconds = 1800;
    CHECK(prov_store_save(&cfg) == true);

    prov_config_t back;
    CHECK(prov_store_load(&back) == true);
    CHECK_STR(back.ssid, "Home");
    CHECK_STR(back.password, "hunter2");
    CHECK_STR(back.news_url, kUrl);
    CHECK_INT(back.sleep_seconds, 1800);
}

TEST(store_round_trips_unset_as_unset)
{
    /* A board saved from the portal with the interval box left blank must come
     * back as "nobody said", not as the minimum and not as a stored 60. */
    fake_nvs_reset();

    prov_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    strcpy(cfg.ssid, "Home");
    cfg.sleep_seconds = PROV_SLEEP_SECONDS_UNSET;
    CHECK(prov_store_save(&cfg) == true);

    prov_config_t back;
    CHECK(prov_store_load(&back) == true);
    CHECK_INT(back.sleep_seconds, PROV_SLEEP_SECONDS_UNSET);
}

TEST(store_clamps_an_out_of_range_interval_it_is_handed)
{
    /* The clamp is on the store as well as on the form, because the form is not
     * the only writer — POST /api/sleep is another. A value that got past one
     * gate should not be able to reach flash through the other. */
    fake_nvs_reset();

    prov_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    strcpy(cfg.ssid, "Home");
    cfg.sleep_seconds = 5;
    CHECK(prov_store_save(&cfg) == true);

    prov_config_t back;
    CHECK(prov_store_load(&back) == true);
    CHECK_INT(back.sleep_seconds, PROV_SLEEP_SECONDS_MIN);
}

TEST(store_clamps_a_value_it_finds_in_flash)
{
    /* Written by something that did not clamp — an older build, a hand-edited
     * key. The board must not adopt a one-second poll because flash says so. */
    fake_nvs_reset();
    seed_a_provisioned_board();
    fake_nvs_seed_u32(KEY_SLEEP, 1);

    prov_config_t cfg;
    CHECK(prov_store_load(&cfg) == true);
    CHECK_INT(cfg.sleep_seconds, PROV_SLEEP_SECONDS_MIN);
}

TEST(store_reports_nothing_stored_when_only_the_interval_is)
{
    /* prov_store_load()'s return value means "is there a network to join", and
     * adding a field must not widen it. An interval with no SSID is not a
     * provisioned board — it is a board that still needs the portal. */
    fake_nvs_reset();
    fake_nvs_seed_u32(KEY_SLEEP, 900);

    prov_config_t cfg;
    CHECK(prov_store_load(&cfg) == false);
    CHECK_INT(cfg.sleep_seconds, 900);   // read anyway; only the SSID decides the verdict
}

TEST(store_load_zeroes_the_interval_when_nothing_is_stored_at_all)
{
    /* A board that has never been provisioned: the namespace does not exist and
     * nvs_open() itself fails. The config still has to come back defined. */
    fake_nvs_reset();

    prov_config_t cfg;
    memset(&cfg, 0xAB, sizeof(cfg));     // poison, to prove load() zeroes first
    CHECK(prov_store_load(&cfg) == false);
    CHECK_STR(cfg.ssid, "");
    CHECK_INT(cfg.sleep_seconds, PROV_SLEEP_SECONDS_UNSET);
}

TEST(store_clear_forgets_the_interval_too)
{
    fake_nvs_reset();

    prov_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    strcpy(cfg.ssid, "Home");
    cfg.sleep_seconds = 1800;
    CHECK(prov_store_save(&cfg) == true);

    prov_store_clear();
    CHECK(fake_nvs_has_key(KEY_SLEEP) == false);

    prov_config_t back;
    CHECK(prov_store_load(&back) == false);
    CHECK_INT(back.sleep_seconds, PROV_SLEEP_SECONDS_UNSET);
}
