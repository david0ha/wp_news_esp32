#include "tf.h"
#include "prov_config.h"

#include <stdint.h>

/* prov_validate_credentials is the whole of prov_config now that the watchlist
 * is gone, and it is the gate the companion app's error codes are derived from
 * (POST /api/provision maps each result to a typed Esp32Error). */

TEST(credentials_accept_a_normal_network)
{
    CHECK(prov_validate_credentials("My Net", "hunter2") == PROV_CRED_OK);
}

TEST(credentials_allow_an_open_network)
{
    /* An empty password is a legitimate open network, not a mistake. */
    CHECK(prov_validate_credentials("Cafe WiFi", "") == PROV_CRED_OK);
    CHECK(prov_validate_credentials("Cafe WiFi", NULL) == PROV_CRED_OK);
}

TEST(credentials_reject_an_empty_ssid)
{
    CHECK(prov_validate_credentials("", "pw") == PROV_CRED_SSID_EMPTY);
    CHECK(prov_validate_credentials(NULL, "pw") == PROV_CRED_SSID_EMPTY);
}

TEST(credentials_enforce_the_802_11_limits)
{
    char ssid[PROV_SSID_MAX_LEN + 8];
    char pass[PROV_PASS_MAX_LEN + 8];

    /* Exactly at the limit is valid — off-by-one here would reject legitimate
     * networks with no way for the user to tell why. */
    for (int i = 0; i < PROV_SSID_MAX_LEN; i++) ssid[i] = 'a';
    ssid[PROV_SSID_MAX_LEN] = '\0';
    CHECK(prov_validate_credentials(ssid, "pw") == PROV_CRED_OK);

    ssid[PROV_SSID_MAX_LEN] = 'a';
    ssid[PROV_SSID_MAX_LEN + 1] = '\0';
    CHECK(prov_validate_credentials(ssid, "pw") == PROV_CRED_SSID_TOO_LONG);

    for (int i = 0; i < PROV_PASS_MAX_LEN; i++) pass[i] = 'x';
    pass[PROV_PASS_MAX_LEN] = '\0';
    CHECK(prov_validate_credentials("net", pass) == PROV_CRED_OK);

    pass[PROV_PASS_MAX_LEN] = 'x';
    pass[PROV_PASS_MAX_LEN + 1] = '\0';
    CHECK(prov_validate_credentials("net", pass) == PROV_CRED_PASS_TOO_LONG);
}

TEST(credentials_check_the_ssid_before_the_password)
{
    /* Both wrong: the caller shows one message, and "enter a network name" is
     * the more useful one. */
    char pass[PROV_PASS_MAX_LEN + 8];
    for (int i = 0; i < PROV_PASS_MAX_LEN + 1; i++) pass[i] = 'x';
    pass[PROV_PASS_MAX_LEN + 1] = '\0';
    CHECK(prov_validate_credentials("", pass) == PROV_CRED_SSID_EMPTY);
}

/* prov_validate_news_url is the gate on the one field a user types by hand and
 * gets wrong. Its job is not to be a URL parser — it is to catch the two
 * mistakes people actually make (no scheme at all, and a path with no host) and
 * to let everything else through, because a device that rejects a legitimate
 * URL it does not recognise is worse than one that fails at connect time with a
 * message the user can read in the log. */

TEST(news_url_accepts_empty_as_the_demo_screen)
{
    /* Not an oversight: an unconfigured board is a complete product that shows
     * the built-in snapshot. Rejecting empty would force everyone to stand up a
     * server before the display would boot into anything. */
    CHECK(prov_validate_news_url("") == true);
    CHECK(prov_validate_news_url(NULL) == true);
}

TEST(news_url_accepts_the_shapes_a_lan_actually_uses)
{
    CHECK(prov_validate_news_url("http://macbook.local:8123/news.json") == true);
    CHECK(prov_validate_news_url("http://192.168.1.42:8123/news.json") == true);
    CHECK(prov_validate_news_url("https://news.example.com/snapshot") == true);
    CHECK(prov_validate_news_url("http://host") == true);          /* no path */
    CHECK(prov_validate_news_url("http://h/a?b=c&d=e") == true);    /* query   */
}

TEST(news_url_rejects_a_missing_scheme)
{
    /* The single most common paste. Without a scheme esp_http_client does not
     * fail loudly — it fails obscurely. */
    CHECK(prov_validate_news_url("macbook.local:8123/news.json") == false);
    CHECK(prov_validate_news_url("192.168.1.42") == false);
    CHECK(prov_validate_news_url("file:///Users/me/news.json") == false);
    CHECK(prov_validate_news_url("ftp://host/x") == false);
}

TEST(news_url_rejects_a_scheme_with_no_host)
{
    CHECK(prov_validate_news_url("http://") == false);
    CHECK(prov_validate_news_url("https://") == false);
    CHECK(prov_validate_news_url("http:///news.json") == false);
}

TEST(news_url_enforces_the_stored_length)
{
    /* Exactly at the limit must pass: prov_config_t has room for
     * PROV_URL_MAX_LEN characters plus the NUL, and rejecting the last one
     * would waste a byte nobody can see. */
    char url[PROV_URL_MAX_LEN + 8];
    const char *prefix = "http://h/";
    size_t plen = strlen(prefix);
    memcpy(url, prefix, plen);
    for (size_t i = plen; i < PROV_URL_MAX_LEN; i++) url[i] = 'a';
    url[PROV_URL_MAX_LEN] = '\0';
    CHECK(prov_validate_news_url(url) == true);

    url[PROV_URL_MAX_LEN] = 'a';
    url[PROV_URL_MAX_LEN + 1] = '\0';
    CHECK(prov_validate_news_url(url) == false);
}

/* The sleep interval is the one number in the config a user is allowed to be
 * careless with: it arrives from an optional box on a setup form, from a phone,
 * or not at all. prov_clamp_sleep_seconds() is where all three meet, and it has
 * to hold two properties at once — every answered value lands inside a range the
 * board can actually run on, and *unanswered* survives as unanswered. Zero is
 * not a short sleep, it is "nobody said", and the board is meant to fall back to
 * its build-time default. Folding zero into the clamp would make every untouched
 * board silently adopt the minimum, which is the busiest interval there is. */

TEST(sleep_clamp_passes_unset_straight_through)
{
    CHECK_INT(PROV_SLEEP_SECONDS_UNSET, 0);
    CHECK_INT(prov_clamp_sleep_seconds(PROV_SLEEP_SECONDS_UNSET), PROV_SLEEP_SECONDS_UNSET);
}

TEST(sleep_clamp_raises_a_value_under_the_floor)
{
    CHECK_INT(prov_clamp_sleep_seconds(1), PROV_SLEEP_SECONDS_MIN);
    CHECK_INT(prov_clamp_sleep_seconds(59), PROV_SLEEP_SECONDS_MIN);
    CHECK_INT(prov_clamp_sleep_seconds(60), 60);
    CHECK_INT(PROV_SLEEP_SECONDS_MIN, 60);
}

TEST(sleep_clamp_leaves_a_usable_interval_alone)
{
    CHECK_INT(prov_clamp_sleep_seconds(900), 900);
    CHECK_INT(prov_clamp_sleep_seconds(1800), 1800);
    CHECK_INT(prov_clamp_sleep_seconds(PROV_SLEEP_SECONDS_MAX), PROV_SLEEP_SECONDS_MAX);
    CHECK_INT(PROV_SLEEP_SECONDS_MAX, 86400);
}

TEST(sleep_clamp_caps_the_ceiling)
{
    CHECK_INT(prov_clamp_sleep_seconds(86401), PROV_SLEEP_SECONDS_MAX);
    CHECK_INT(prov_clamp_sleep_seconds(UINT32_MAX), PROV_SLEEP_SECONDS_MAX);
}

/* prov_parse_sleep_seconds() is the portal form's half of the same idea. The
 * field is optional, so the only sane reading of anything that is not a number
 * is "unanswered" — never an error. A user who fat-fingers a box they did not
 * have to fill in must still get their Wi-Fi saved; a setup page that throws the
 * whole form back over a stray letter is a board that never gets on the network. */

TEST(sleep_field_parses_the_number_a_user_typed)
{
    CHECK_INT(prov_parse_sleep_seconds("1800"), 1800);
    CHECK_INT(prov_parse_sleep_seconds("900"), 900);
    CHECK_INT(prov_parse_sleep_seconds("86400"), 86400);
}

TEST(sleep_field_reads_an_empty_box_as_unset)
{
    CHECK_INT(prov_parse_sleep_seconds(""), PROV_SLEEP_SECONDS_UNSET);
    CHECK_INT(prov_parse_sleep_seconds(NULL), PROV_SLEEP_SECONDS_UNSET);
    CHECK_INT(prov_parse_sleep_seconds("   "), PROV_SLEEP_SECONDS_UNSET);
}

TEST(sleep_field_reads_junk_as_unset_rather_than_as_zero)
{
    /* Not "0 seconds", not a rejection of the form — unanswered. */
    CHECK_INT(prov_parse_sleep_seconds("abc"), PROV_SLEEP_SECONDS_UNSET);
    CHECK_INT(prov_parse_sleep_seconds("30 minutes"), PROV_SLEEP_SECONDS_UNSET);
    CHECK_INT(prov_parse_sleep_seconds("-900"), PROV_SLEEP_SECONDS_UNSET);
    CHECK_INT(prov_parse_sleep_seconds("15.5"), PROV_SLEEP_SECONDS_UNSET);
    CHECK_INT(prov_parse_sleep_seconds("0"), PROV_SLEEP_SECONDS_UNSET);
}

TEST(sleep_field_clamps_what_it_parses)
{
    /* One gate, not two: whatever route the number took, it lands in range. */
    CHECK_INT(prov_parse_sleep_seconds("5"), PROV_SLEEP_SECONDS_MIN);
    CHECK_INT(prov_parse_sleep_seconds("99999"), PROV_SLEEP_SECONDS_MAX);
    /* Absurd, and long enough to overflow a uint32_t on the way in. It must come
     * out as the ceiling; a wrap would come out as some short interval instead,
     * and the board would poll every few seconds for the rest of its life. */
    CHECK_INT(prov_parse_sleep_seconds("99999999999999999999"), PROV_SLEEP_SECONDS_MAX);
}

TEST(sleep_field_tolerates_the_spaces_a_text_box_collects)
{
    CHECK_INT(prov_parse_sleep_seconds(" 1800 "), 1800);
    CHECK_INT(prov_parse_sleep_seconds("18 00"), PROV_SLEEP_SECONDS_UNSET);
}
