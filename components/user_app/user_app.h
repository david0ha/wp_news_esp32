#pragma once

#include "prov_config.h"   /* prov_config_t — the provisioned WiFi + news URL */

#ifdef __cplusplus
extern "C" {
#endif

void UserApp_AppInit(void);   /* cJSON PSRAM hooks   */
void UserApp_UiInit(void);    /* build the news UI  */

/* Spawn the UI task and the news poller.
 *
 * `btn_gpios` is the board's button pins in button_id_t order (KEY0, KEY1,
 * KEY2, BOOT); `btn_count` is how many are supplied. They are passed in rather
 * than included because the pinout lives in main/user_config.h, and a component
 * reaching into the application's headers is how a "portable" component stops
 * being one. */
void UserApp_TaskInit(const prov_config_t *cfg, const int *btn_gpios, int btn_count);

/* The KEY2-held-five-seconds escape hatch, checked at boot instead of from a
 * running UI task.
 *
 * It used to live inside handle_press(), which only runs once UiTask is up —
 * and under deep sleep UiTask may never run at all, because a board that wakes,
 * finds nothing changed and sleeps again never builds a UI. The documented way
 * back into a board stuck on an unreachable network would have died the day
 * deep sleep shipped. So it moves to the top of the full boot path, where it
 * costs nothing (a button that is not held returns in one poll interval) and
 * lands before provisioning_run() reads the flag, so the portal comes up on
 * THIS boot rather than after a restart.
 *
 * Also releases the wake pins from RTC-IO mode — see the note in the
 * implementation. Call once, early, with the same array UserApp_TaskInit gets.
 * Returns true if the flag was set. handle_press() keeps its own check for the
 * board that is awake when the user reaches for the button. */
bool user_app_check_force_ap_at_boot(const int *btn_gpios, int btn_count);

#ifdef __cplusplus
}
#endif
