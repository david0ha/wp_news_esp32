// Host stand-in for ESP-IDF's logging macros: they swallow their arguments so
// the suite's output stays a list of test names.
//
// They still *evaluate* them, which matters — a macro that expanded to nothing
// would leave prov_store.c's file-static TAG unreferenced and -Werror would
// reject the file for a reason that has nothing to do with the test.
#pragma once

void fake_idf_log(const char *tag, const char *fmt, ...);

#define ESP_LOGE(...) fake_idf_log(__VA_ARGS__)
#define ESP_LOGW(...) fake_idf_log(__VA_ARGS__)
#define ESP_LOGI(...) fake_idf_log(__VA_ARGS__)
#define ESP_LOGD(...) fake_idf_log(__VA_ARGS__)
#define ESP_LOGV(...) fake_idf_log(__VA_ARGS__)
