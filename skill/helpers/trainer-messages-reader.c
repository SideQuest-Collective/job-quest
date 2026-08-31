/*
 * trainer-messages-reader — dedicated Full Disk Access entry point for the
 * Job Quest interview-trainer reply poller.
 *
 * macOS gates the Messages database (~/Library/Messages/chat.db) behind Full
 * Disk Access, attributed to the *responsible process* of a launchd job — the
 * executable named in the job's ProgramArguments. Running the poller through
 * this tiny dedicated binary means the user grants FDA to exactly one
 * single-purpose program instead of /bin/bash (which would extend the grant to
 * every shell script on the machine).
 *
 * All it does is exec the poller script; the script and its children
 * (sqlite3, python3, osascript) inherit this binary's TCC attribution.
 *
 * Built by install.sh:
 *   clang -O2 -o ~/.job-quest/bin/trainer-messages-reader trainer-messages-reader.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    const char *home = getenv("HOME");
    if (home == NULL || home[0] == '\0') {
        fprintf(stderr, "trainer-messages-reader: HOME is not set\n");
        return 1;
    }

    char script[4096];
    int n = snprintf(script, sizeof(script), "%s/.job-quest/bin/run-trainer-replies.sh", home);
    if (n < 0 || (size_t)n >= sizeof(script)) {
        fprintf(stderr, "trainer-messages-reader: HOME path too long\n");
        return 1;
    }

    if (access(script, X_OK) != 0) {
        fprintf(stderr, "trainer-messages-reader: %s is missing or not executable\n", script);
        return 1;
    }

    /* argv passthrough: /bin/bash <script> [args...] */
    char **child_argv = calloc((size_t)argc + 2, sizeof(char *));
    if (child_argv == NULL) {
        fprintf(stderr, "trainer-messages-reader: out of memory\n");
        return 1;
    }
    child_argv[0] = "/bin/bash";
    child_argv[1] = script;
    for (int i = 1; i < argc; i++) {
        child_argv[i + 1] = argv[i];
    }

    execv("/bin/bash", child_argv);
    perror("trainer-messages-reader: execv /bin/bash");
    return 1;
}
