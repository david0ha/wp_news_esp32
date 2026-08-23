#!/bin/sh
# Compile and run the host unit tests for the provisioning component's pure logic.
# Only host-safe (no ESP-IDF dependency) sources are listed here.
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)

PURE_SRCS="$ROOT/prov_config.c $ROOT/form_parse.c $ROOT/prov_json.c"

# prov_store.c is the one exception, and it is a deliberate one. It talks to
# NVS, so it comes in against the in-memory stand-in in fake_idf/ — because the
# behaviour that must never regress is what it does with a key that is NOT
# there, and that state cannot be reached by calling the store's own save().
# See test_prov_store.c.
STORE_SRCS="$ROOT/prov_store.c $DIR/fake_idf/fake_nvs.c"

TEST_SRCS="$DIR/tf_main.c $DIR"/test_*.c

# shellcheck disable=SC2086
# Note: AddressSanitizer is intentionally not used — its shadow-memory mmap is
# blocked in the sandbox and hangs. UndefinedBehaviorSanitizer works fine.
cc -std=c11 -Wall -Wextra -Werror -g -O0 \
    -fsanitize=undefined -fno-sanitize-recover=all \
    -I"$ROOT" -I"$DIR" -I"$DIR/fake_idf" \
    $PURE_SRCS $STORE_SRCS $TEST_SRCS \
    -o "$DIR/run_tests"

"$DIR/run_tests"
