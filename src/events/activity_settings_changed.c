/*
 * Copyright (c) 2026 The ZMK Contributors
 *
 * SPDX-License-Identifier: MIT
 */

#include <zephyr/logging/log.h>
#include <zmk/activity.h>
#include <zmk/event_manager.h>
#include <zmk/events/activity_settings_changed.h>

ZMK_EVENT_IMPL(zmk_activity_settings_changed);

// Only a split peripheral applies settings relayed from the central. The
// central sets its own timeouts directly and has no reason to take them from a
// peripheral, so it neither receives nor applies this event.
#if IS_ENABLED(CONFIG_ZMK_SPLIT) && !IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)

#ifndef CONFIG_ZMK_MODULE_SETTINGS_RPC_LOG_LEVEL
#define CONFIG_ZMK_MODULE_SETTINGS_RPC_LOG_LEVEL 3
#endif
LOG_MODULE_REGISTER(zmk_module_settings_rpc_activity_settings_changed,
                    CONFIG_ZMK_MODULE_SETTINGS_RPC_LOG_LEVEL);

/**
 * Event listener to apply activity settings when relay event is received
 */
static int activity_settings_changed_listener(const zmk_event_t *eh) {
    struct zmk_activity_settings_changed *ev =
        as_zmk_activity_settings_changed(eh);
    if (!ev) {
        return ZMK_EV_EVENT_BUBBLE;
    }

    // Only apply settings from relayed events (not self-originated)
    if (ev->source != ZMK_RELAY_EVENT_SOURCE_SELF) {
        LOG_DBG(
            "Applying relayed activity settings: idle=%d ms, sleep=%d ms from "
            "source %d",
            ev->idle_ms, ev->sleep_ms, ev->source);

        zmk_activity_set_idle_ms(ev->idle_ms);
        zmk_activity_set_sleep_ms(ev->sleep_ms);
    }

    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(activity_settings_apply, activity_settings_changed_listener);
ZMK_SUBSCRIPTION(activity_settings_apply, zmk_activity_settings_changed);

#if IS_ENABLED(CONFIG_ZMK_SPLIT_RELAY_EVENT)

ZMK_RELAY_EVENT_HANDLE(zmk_activity_settings_changed, as, source);

#endif  // IS_ENABLED(CONFIG_ZMK_SPLIT_RELAY_EVENT)

#endif  // IS_ENABLED(CONFIG_ZMK_SPLIT) && !CONFIG_ZMK_SPLIT_ROLE_CENTRAL
