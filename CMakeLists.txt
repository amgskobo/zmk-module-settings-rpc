# ZMK Settings RPC Module CMakeLists.txt

# Include directories
zephyr_include_directories(include)
if(CONFIG_ZMK_SETTINGS_RPC)
    # Add event source files
    target_sources(app PRIVATE src/events/activity_settings_changed.c)
    target_sources(app PRIVATE src/events/activity_settings_report.c)

    if(CONFIG_ZMK_SETTINGS_RPC_STUDIO)
        target_sources(app PRIVATE src/studio/settings_rpc_handler.c)

        list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
        include(nanopb)
        set(NANOPB_GENERATE_CPP_APPEND_PATH TRUE)
        set(NANOPB_GENERATE_CPP_STANDALONE OFF)

        # NOTE: adding to app target directly causes build issues, so we create a library instead
        zephyr_library()
        nanopb_generate_cpp(proto_srcs proto_hdrs RELPATH ${CMAKE_CURRENT_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}/proto/zmk/settings/core.proto)
        target_include_directories(${ZEPHYR_CURRENT_LIBRARY} PUBLIC ${CMAKE_CURRENT_BINARY_DIR})
        target_sources(${ZEPHYR_CURRENT_LIBRARY} PRIVATE ${proto_srcs} ${proto_hdrs})

        # app should depend on the generated proto files
        target_include_directories(app PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/proto)
        add_dependencies(app ${ZEPHYR_CURRENT_LIBRARY})
    endif()
endif()
