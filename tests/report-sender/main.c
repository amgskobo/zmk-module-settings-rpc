/* SPDX-License-Identifier: MIT */
#include <pb_decode.h>
#include <pb_encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zmk/settings/core.pb.h>

#define CHECK(value)                                                           \
  do {                                                                         \
    if (!(value)) {                                                            \
      printk("FAIL line=%d: %s\n", __LINE__, #value);                          \
      exit(1);                                                                 \
    }                                                                          \
  } while (0)
#define LOG_MODULE_DECLARE(...)
#define LOG_MODULE_REGISTER(...)
#define LOG_DBG(...)
#define LOG_WRN(...)
#define LOG_ERR(...)
#define ZMK_EVENT_DECLARE(...)
#define ZMK_LISTENER(...)
#define ZMK_SUBSCRIPTION(...)
#define ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL(...)
#define ZMK_RELAY_EVENT_HANDLE(...)
#define ZMK_EV_EVENT_BUBBLE 0
#define ZMK_RELAY_EVENT_SOURCE_SELF 255
#include <zmk/events/activity_settings_changed.h>
#include <zmk/events/activity_settings_report.h>
typedef struct {
  struct zmk_activity_settings_report *report;
} zmk_event_t;
static struct zmk_activity_settings_report *
as_zmk_activity_settings_report(const zmk_event_t *event) {
  return event->report;
}
static uint32_t zmk_activity_get_idle_ms(void) { return 1000; }
static uint32_t zmk_activity_get_sleep_ms(void) { return 2000; }
static bool zmk_activity_set_idle_ms(uint32_t value) {
  (void)value;
  return true;
}
static bool zmk_activity_set_sleep_ms(uint32_t value) {
  (void)value;
  return true;
}
static void raise_zmk_activity_settings_changed(
    struct zmk_activity_settings_changed value) {
  (void)value;
}
static void raise_zmk_activity_settings_request(
    struct zmk_activity_settings_request value) {
  (void)value;
}
typedef struct {
  struct {
    size_t size;
    uint8_t bytes[128];
  } payload;
} zmk_custom_CallRequest;
struct zmk_rpc_custom_subsystem_meta {
  const char *url;
  unsigned security;
};
struct zmk_rpc_custom_subsystem {
  const char *identifier;
};
#define ZMK_STUDIO_RPC_HANDLER_UNSECURED 0
#define ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS(value) .url = value
#define ZMK_RPC_CUSTOM_SUBSYSTEM(id, meta, handler)                            \
  static bool handler(const zmk_custom_CallRequest *, pb_callback_t *)
static zmk_settings_Response response_buffer;
#define ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(id, type)
#define ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(id, callback)        \
  (&response_buffer)
static struct zmk_rpc_custom_subsystem subsystem = {"zmk__settings"};
#undef STRUCT_SECTION_COUNT
#undef STRUCT_SECTION_GET
#define STRUCT_SECTION_COUNT(type, value) (*(value) = 1)
#define STRUCT_SECTION_GET(type, index, value) (*(value) = &subsystem)
struct zmk_studio_custom_notification {
  uint8_t subsystem_index;
  pb_callback_t encode_payload;
};
static void raise_zmk_studio_custom_notification(
    struct zmk_studio_custom_notification event);
static struct k_work_q queue;
K_THREAD_STACK_DEFINE(queue_stack, 4096);
static struct k_work_q *zmk_workqueue_lowprio_work_q(void) { return &queue; }
/* The setter's lock check is not exercised here; reports never consult it. */
enum zmk_studio_core_lock_state {
  ZMK_STUDIO_CORE_LOCK_STATE_LOCKED = 0,
  ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED = 1,
};
static enum zmk_studio_core_lock_state zmk_studio_core_get_lock_state(void) {
  return ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
}
#include RPC_SOURCE

K_SEM_DEFINE(block_entered, 0, 1);
K_SEM_DEFINE(block_release, 0, 1);
K_SEM_DEFINE(peer_done, 0, 1);
K_SEM_DEFINE(sent_done, 0, 1);
static unsigned sent, limit, next_source;
static bool refill;
static void report(unsigned source) {
  struct zmk_activity_settings_report value = {
      .source = source, .idle_ms = source * 17, .sleep_ms = source * 23};
  zmk_event_t event = {.report = &value};
  CHECK(activity_settings_report_listener(&event) == ZMK_EV_EVENT_BUBBLE);
}
static void raise_zmk_studio_custom_notification(
    struct zmk_studio_custom_notification event) {
  CHECK(event.subsystem_index == 0 && k_current_get() == &queue.thread);
  uint8_t bytes[128];
  pb_field_t field = {.tag = 1, .type = PB_LTYPE_BYTES};
  pb_ostream_t stream = pb_ostream_from_buffer(bytes, sizeof(bytes));
  CHECK(event.encode_payload.funcs.encode(&stream, &field,
                                          &event.encode_payload.arg));
  pb_istream_t input = pb_istream_from_buffer(bytes, stream.bytes_written),
               payload;
  pb_wire_type_t type;
  uint32_t tag;
  bool eof;
  CHECK(pb_decode_tag(&input, &type, &tag, &eof) && tag == 1 &&
        type == PB_WT_STRING);
  CHECK(pb_make_string_substream(&input, &payload));
  zmk_settings_Notification value = zmk_settings_Notification_init_zero;
  CHECK(pb_decode(&payload, zmk_settings_Notification_fields, &value));
  CHECK(pb_close_string_substream(&input, &payload) && input.bytes_left == 0);
  CHECK(value.which_notification_type ==
        zmk_settings_Notification_activity_settings_tag);
  zmk_settings_ActivitySettingsNotification *notification =
      &value.notification_type.activity_settings;
  CHECK(notification->has_settings &&
        notification->settings.source == sent + 1);
  CHECK(notification->settings.idle_ms == (sent + 1) * 17 &&
        notification->settings.sleep_ms == (sent + 1) * 23);
  sent++;
  printk("at=%lld report=%u\n", k_uptime_get(), sent);
  if (refill && next_source <= limit) {
    report(next_source++);
  }
  if (sent == limit) {
    k_sem_give(&sent_done);
  }
}
static void block_handler(struct k_work *work) {
  (void)work;
  k_sem_give(&block_entered);
  CHECK(k_sem_take(&block_release, K_MSEC(1000)) == 0);
}
static void peer_handler(struct k_work *work) {
  (void)work;
  printk("at=%lld peer reports_before=%u\n", k_uptime_get(), sent);
  CHECK(sent == 1);
  k_sem_give(&peer_done);
}
K_WORK_DEFINE(block_work, block_handler);
K_WORK_DEFINE(peer_work, peer_handler);
int main(void) {
  const char *scenario = getenv("SETTINGS_REPORT_CASE");
  CHECK(scenario);
  refill = !strcmp(scenario, "refill");
  CHECK(refill || !strcmp(scenario, "full"));
  limit = refill ? 8 : 4;
  next_source = 2;
  k_work_queue_start(&queue, queue_stack, K_THREAD_STACK_SIZEOF(queue_stack),
                     10, NULL);
  CHECK(k_work_submit_to_queue(&queue, &block_work) >= 0);
  CHECK(k_sem_take(&block_entered, K_MSEC(500)) == 0);
  if (refill) {
    report(1);
  } else {
    for (unsigned i = 1; i <= 6; i++) {
      report(i);
    }
  }
  CHECK(sent == 0);
  CHECK(k_work_submit_to_queue(&queue, &peer_work) >= 0);
  k_sem_give(&block_release);
  CHECK(k_sem_take(&peer_done, K_MSEC(1000)) == 0);
  CHECK(k_sem_take(&sent_done, K_MSEC(1000)) == 0);
  struct k_work_sync sync;
  while (k_work_flush(&activity_report_work, &sync)) {
  }
  CHECK(sent == limit &&
        k_msgq_num_used_get(&zmk_settings_rpc_report_msgq) == 0);
  printk("PASS settings report sender scenario=%s ordered=%u peer_after=1\n",
         scenario, sent);
  exit(0);
}
