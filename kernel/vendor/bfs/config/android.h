// bfs 4.1.4 的 gen/config.h，目标族 android（docs/specs/rust-cli/embedded-search.md §6.2）。
// 以 linux-gnu 的 configure 结果为基线，按 bionic 的差异收窄（NDK API 26）：
// - 没有 <mntent.h>、GNU strerror_r、program_invocation_short_name；
// - statx 在 Android 10 及以下会被 seccomp 杀掉，关掉（bfs 自己的 build/has/statx-syscall.c 也这么写）；
// - confstr/ctermid/pthread_setname_np/sched_getaffinity 等不假设存在，走 bfs 的回退。
// Oniguruma 由 build.rs 编，这里打开。
#ifndef BFS_CONFIG_H
#define BFS_CONFIG_H
#define BFS_WITH_LIBACL false
#define BFS_WITH_LIBCAP false
#define BFS_WITH_LIBSELINUX false
#define BFS_WITH_LIBURING false
#define BFS_WITH_ONIGURUMA true
#define BFS_HAS___ST_BIRTHTIM false
#define BFS_HAS__FORK false
#define BFS_HAS_ACL_GET_ENTRY false
#define BFS_HAS_ACL_GET_FILE false
#define BFS_HAS_ACL_GET_TAG_TYPE false
#define BFS_HAS_ACL_IS_TRIVIAL_NP false
#define BFS_HAS_ACL_TRIVIAL false
#define BFS_HAS_BUILTIN_RISCV_PAUSE false
#define BFS_HAS_CONFSTR false
#define BFS_HAS_CTERMID false
#define BFS_HAS_DPRINTF true
#define BFS_HAS_EXTATTR_GET_FILE false
#define BFS_HAS_EXTATTR_GET_LINK false
#define BFS_HAS_EXTATTR_LIST_FILE false
#define BFS_HAS_EXTATTR_LIST_LINK false
#define BFS_HAS_FCHDIR true
#define BFS_HAS_FDCLOSEDIR false
#define BFS_HAS_GETDENTS false
#define BFS_HAS_GETDENTS64_SYSCALL true
#define BFS_HAS_GETDENTS64 false
#define BFS_HAS_GETMNTENT_1 false
#define BFS_HAS_GETMNTENT_2 false
#define BFS_HAS_GETMNTINFO false
#define BFS_HAS_GETPROGNAME_GNU false
#define BFS_HAS_GETPROGNAME false
#define BFS_HAS_IO_URING_MAX_WORKERS false
#define BFS_HAS_PIPE2 true
#define BFS_HAS_PRAGMA_NOUNROLL true
#define BFS_HAS_POSIX_GETDENTS false
#define BFS_HAS_POSIX_SPAWN_ADDFCHDIR_NP false
#define BFS_HAS_POSIX_SPAWN_ADDFCHDIR false
#define BFS_HAS_PTHREAD_SET_NAME_NP false
#define BFS_HAS_PTHREAD_SETNAME_NP false
#define BFS_HAS_SCHED_GETAFFINITY false
#define BFS_HAS_ST_ACMTIM true
#define BFS_HAS_ST_ACMTIMESPEC false
#define BFS_HAS_ST_BIRTHTIM false
#define BFS_HAS_ST_BIRTHTIMESPEC false
#define BFS_HAS_ST_FLAGS false
#define BFS_HAS_STATX_SYSCALL false
#define BFS_HAS_STATX false
#define BFS_HAS_STRERROR_L false
#define BFS_HAS_STRERROR_R_GNU false
#define BFS_HAS_STRERROR_R_POSIX true
#define BFS_HAS_STRING_TO_FLAGS false
#define BFS_HAS_STRTOFFLAGS false
#define BFS_HAS_SYSCTLBYNAME false
#define BFS_HAS_TCGETWINSIZE false
#define BFS_HAS_TCSETWINSIZE false
#define BFS_HAS_TIMEGM true
#define BFS_HAS_TIMER_CREATE true
#define BFS_HAS_TM_GMTOFF true
#define BFS_HAS_USELOCALE false
#endif // BFS_CONFIG_H
