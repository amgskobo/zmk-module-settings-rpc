cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(settings_report_sender)
target_sources(app PRIVATE main.c "${GENERATED_ROOT}/zmk/settings/core.pb.c"
  "${NANOPB_ROOT}/pb_common.c" "${NANOPB_ROOT}/pb_encode.c" "${NANOPB_ROOT}/pb_decode.c")
target_include_directories(app PRIVATE "${GENERATED_ROOT}" "${NANOPB_ROOT}" "${OWNER_ROOT}/include")
target_compile_definitions(app PRIVATE RPC_SOURCE="${RPC_SOURCE}" PB_WITHOUT_64BIT=1
  CONFIG_ZMK_SPLIT=1 CONFIG_ZMK_SPLIT_ROLE_CENTRAL=1 CONFIG_ZMK_SPLIT_RELAY_EVENT=1)
