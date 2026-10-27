cmake_minimum_required(VERSION 3.21)

cmake_policy(SET CMP0091 NEW)
project(zcode_native_ugrep LANGUAGES C CXX)

if(NOT MSVC)
  message(FATAL_ERROR "ZCode Windows ugrep must be built with MSVC")
endif()

foreach(source_name UGREP PCRE2 ZLIB BZIP2 ZSTD BROTLI)
  if(NOT DEFINED NIBI_${source_name}_SOURCE_DIR)
    message(FATAL_ERROR "Missing NIBI_${source_name}_SOURCE_DIR")
  endif()
endforeach()

if(NOT DEFINED NIBI_UGREP_OUTPUT_DIR)
  message(FATAL_ERROR "Missing NIBI_UGREP_OUTPUT_DIR")
endif()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)

# 随机构建目录不能进入最终 PE，否则同版本工具无法跨 CLI 复用同一份 runtime cache。
if(DEFINED NIBI_BUILD_PATH)
  add_compile_options("/pathmap:${NIBI_BUILD_PATH}=zcode-native-search")
endif()

set(BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2_8 ON CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2_16 OFF CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2_32 OFF CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2GREP OFF CACHE BOOL "" FORCE)
set(PCRE2_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(PCRE2_SHOW_REPORT OFF CACHE BOOL "" FORCE)
set(PCRE2_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
set(PCRE2_SUPPORT_JIT ON CACHE BOOL "" FORCE)
add_subdirectory("${NIBI_PCRE2_SOURCE_DIR}" pcre2 EXCLUDE_FROM_ALL)

set(SKIP_INSTALL_ALL ON CACHE BOOL "" FORCE)
add_subdirectory("${NIBI_ZLIB_SOURCE_DIR}" zlib EXCLUDE_FROM_ALL)

add_library(zcode_bzip2 STATIC
  "${NIBI_BZIP2_SOURCE_DIR}/blocksort.c"
  "${NIBI_BZIP2_SOURCE_DIR}/huffman.c"
  "${NIBI_BZIP2_SOURCE_DIR}/crctable.c"
  "${NIBI_BZIP2_SOURCE_DIR}/randtable.c"
  "${NIBI_BZIP2_SOURCE_DIR}/compress.c"
  "${NIBI_BZIP2_SOURCE_DIR}/decompress.c"
  "${NIBI_BZIP2_SOURCE_DIR}/bzlib.c"
)
target_compile_definitions(zcode_bzip2 PRIVATE _CRT_SECURE_NO_WARNINGS)
target_include_directories(zcode_bzip2 PUBLIC "${NIBI_BZIP2_SOURCE_DIR}")

set(ZSTD_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_USE_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
add_subdirectory("${NIBI_ZSTD_SOURCE_DIR}/build/cmake" zstd EXCLUDE_FROM_ALL)

set(BROTLI_BUNDLED_MODE ON CACHE BOOL "" FORCE)
add_subdirectory("${NIBI_BROTLI_SOURCE_DIR}" brotli EXCLUDE_FROM_ALL)

set(NIBI_VIIZ_SOURCE_DIR "${NIBI_UGREP_SOURCE_DIR}/lzma/C")
add_library(zcode_viiz STATIC
  "${NIBI_VIIZ_SOURCE_DIR}/viizip.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zAlloc.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zArcIn.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zBuf.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zBuf2.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zCrc.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zCrcOpt.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zDec.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zFile.c"
  "${NIBI_VIIZ_SOURCE_DIR}/7zStream.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Bcj2.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Bra.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Bra86.c"
  "${NIBI_VIIZ_SOURCE_DIR}/BraIA64.c"
  "${NIBI_VIIZ_SOURCE_DIR}/CpuArch.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Delta.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Lzma2Dec.c"
  "${NIBI_VIIZ_SOURCE_DIR}/LzmaDec.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Ppmd7.c"
  "${NIBI_VIIZ_SOURCE_DIR}/Ppmd7Dec.c"
)
target_compile_definitions(zcode_viiz PRIVATE
  Z7_PPMD_SUPPORT
  Z7_EXTRACT_ONLY
  NDEBUG
  _CRT_SECURE_NO_WARNINGS
)
target_include_directories(zcode_viiz PUBLIC "${NIBI_VIIZ_SOURCE_DIR}")

set(NIBI_REFLEX_SOURCES
  "${NIBI_UGREP_SOURCE_DIR}/lib/block_scripts.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/composer.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/convert.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/debug.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/error.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/input.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/language_scripts.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/letter_case.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/letter_scripts.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/matcher.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/pattern.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/posix.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/simd.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/unicode.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/lib/utf8.cpp"
)

add_library(zcode_reflex STATIC ${NIBI_REFLEX_SOURCES})
target_compile_definitions(zcode_reflex PRIVATE WITH_NO_CODEGEN)

add_executable(ugrep
  "${NIBI_UGREP_SOURCE_DIR}/src/ugrep.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/cnf.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/glob.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/output.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/query.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/screen.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/stats.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/vkey.cpp"
  "${NIBI_UGREP_SOURCE_DIR}/src/zopen.c"
)

add_library(zcode_ugrep_contract INTERFACE)
target_compile_definitions(zcode_ugrep_contract INTERFACE
  HAVE_LIBBROTLI
  HAVE_LIBBZ2
  HAVE_LIBZ
  HAVE_LIBZSTD
  HAVE_PCRE2
  NDEBUG
  PCRE2_STATIC
  WITH_COLOR
  WITH_NO_INDENT
  _CONSOLE
  _CRT_NONSTDC_NO_WARNINGS
  _CRT_SECURE_NO_WARNINGS
)
if(CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  target_compile_definitions(zcode_ugrep_contract INTERFACE HAVE_NEON)
else()
  target_compile_definitions(zcode_ugrep_contract INTERFACE HAVE_SSE2)
endif()
target_compile_features(zcode_ugrep_contract INTERFACE cxx_std_17)
# ugrep 固定源码是无 BOM UTF-8；中文 Windows 按 CP936 解析时会触发 C4819/C1070，并改写 UTF-8 字符串字面量。
target_compile_options(zcode_ugrep_contract INTERFACE
  /utf-8
  $<$<COMPILE_LANGUAGE:CXX>:/EHsc>
)
target_include_directories(zcode_ugrep_contract INTERFACE
  "${NIBI_UGREP_SOURCE_DIR}/include"
  "${NIBI_UGREP_SOURCE_DIR}/src"
  "${NIBI_VIIZ_SOURCE_DIR}"
)

target_link_libraries(zcode_reflex PRIVATE zcode_ugrep_contract pcre2-8-static)
target_link_libraries(ugrep PRIVATE
  zcode_ugrep_contract
  zcode_reflex
  zcode_viiz
  pcre2-8-static
  zlibstatic
  zcode_bzip2
  libzstd_static
  brotlienc
  brotlidec
  brotlicommon
)
target_link_options(ugrep PRIVATE /Brepro)
set_target_properties(ugrep PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${NIBI_UGREP_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${NIBI_UGREP_OUTPUT_DIR}"
)
