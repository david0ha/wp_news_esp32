#include "prov_config.h"

#include <string.h>

prov_cred_result_t prov_validate_credentials(const char *ssid, const char *password)
{
    if (ssid == NULL) {
        ssid = "";
    }
    if (password == NULL) {
        password = "";
    }
    if (ssid[0] == '\0') {
        return PROV_CRED_SSID_EMPTY;
    }
    if (strlen(ssid) > PROV_SSID_MAX_LEN) {
        return PROV_CRED_SSID_TOO_LONG;
    }
    if (strlen(password) > PROV_PASS_MAX_LEN) {
        return PROV_CRED_PASS_TOO_LONG;
    }
    return PROV_CRED_OK;
}

bool prov_validate_news_url(const char *url)
{
    if (url == NULL || url[0] == '\0') {
        return true;                      // empty == run on the demo snapshot
    }
    if (strlen(url) > PROV_URL_MAX_LEN) {
        return false;
    }

    const char *rest;
    if (strncmp(url, "http://", 7) == 0) {
        rest = url + 7;
    } else if (strncmp(url, "https://", 8) == 0) {
        rest = url + 8;
    } else {
        return false;
    }

    // Require at least one character of host before the path. "http://" and
    // "http:///news.json" both parse as a URL and both fail at connect time
    // with an error the user cannot act on.
    return rest[0] != '\0' && rest[0] != '/';
}

uint32_t prov_clamp_sleep_seconds(uint32_t seconds)
{
    if (seconds == PROV_SLEEP_SECONDS_UNSET) {
        return PROV_SLEEP_SECONDS_UNSET;   // "nobody said" — see prov_config.h
    }
    if (seconds < PROV_SLEEP_SECONDS_MIN) {
        return PROV_SLEEP_SECONDS_MIN;
    }
    if (seconds > PROV_SLEEP_SECONDS_MAX) {
        return PROV_SLEEP_SECONDS_MAX;
    }
    return seconds;
}

uint32_t prov_parse_sleep_seconds(const char *text)
{
    if (text == NULL) {
        return PROV_SLEEP_SECONDS_UNSET;
    }

    // A text box collects the spaces around what was typed; the digits are the
    // answer. Anything between them is not, so " 1800 " is 1800 and "18 00" is
    // not a number at all.
    while (*text == ' ' || *text == '\t') {
        text++;
    }
    size_t len = strlen(text);
    while (len > 0 && (text[len - 1] == ' ' || text[len - 1] == '\t')) {
        len--;
    }
    if (len == 0) {
        return PROV_SLEEP_SECONDS_UNSET;
    }

    uint32_t value = 0;
    for (size_t i = 0; i < len; i++) {
        if (text[i] < '0' || text[i] > '9') {
            return PROV_SLEEP_SECONDS_UNSET;
        }
        // Saturate rather than wrap. A wrapped absurd number comes out as some
        // small interval, and the board would then poll every few seconds
        // forever — the failure the whole feature exists to avoid. Keep reading
        // the rest so trailing junk is still caught.
        if (value > PROV_SLEEP_SECONDS_MAX) {
            value = PROV_SLEEP_SECONDS_MAX + 1;
            continue;
        }
        value = value * 10u + (uint32_t)(text[i] - '0');
    }

    return prov_clamp_sleep_seconds(value);
}
