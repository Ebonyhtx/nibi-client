cmake_minimum_required(VERSION 3.20)
project(nibi_runtime_host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(nibi-runtime-host main.cpp)

if(MSVC)
  target_compile_options(nibi-runtime-host PRIVATE /W4 /utf-8)
else()
  target_compile_options(nibi-runtime-host PRIVATE -Wall -Wextra)
  target_link_options(nibi-runtime-host PRIVATE -municode -static)
endif()
