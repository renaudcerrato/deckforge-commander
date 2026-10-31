#!/bin/bash
# Increment a temporary per-key counter and emit text. macOS Bash 3.2.
# See --help. State is separate from counter.py.

set -o pipefail
export LC_ALL=C
umask 077
readonly MAX_COUNT=999999999

fail() {
    printf 'Counter failed.\n' >&2
    exit 1
}

usage() {
    printf '%s\n' \
        'Usage: ./demos/counter.sh [--state-key KEY] [--help]' \
        'Increment once from 1 and emit text. Maximum: 999999999.' \
        'Default identity requires ELGATO_DEVICE_ID, ELGATO_ACTION_UUID,' \
        'and ELGATO_ACTION_CONTEXT; it is session-scoped.' \
        '--state-key KEY names a counter; reusing KEY shares temporary state.' \
        'KEY: 1–4096 bytes, nonblank, no control characters.' \
        'Temporary-file cleanup resets counts; Python and Bash state are separate.' \
        'Busy/stale locks fail. After SIGKILL, confirm the lock is unused before recovery.' \
        'Counts commit before output; delivery is not exactly-once.' >&2
}

valid_identity() {
    [[ ${#1} -gt 0 && ${#1} -le 4096 &&
       "$1" == *[![:space:]]* && "$1" != *[[:cntrl:]]* ]]
}

manual=false
help=false
state_key=''
while (( $# > 0 )); do
    case "$1" in
        --state-key)
            [[ "$manual" == false && $# -ge 2 ]] || fail
            manual=true
            state_key=$2
            valid_identity "$state_key" || fail
            shift 2
            ;;
        --help) help=true; shift ;;
        *) fail ;;
    esac
done
if [[ "$help" == true ]]; then
    usage
    exit 0
fi

# Length framing makes embedded punctuation unambiguous; mode separates identities.
if [[ "$manual" == true ]]; then
    identity=(manual "$state_key")
else
    identity=(automatic "${ELGATO_DEVICE_ID-}" "${ELGATO_ACTION_UUID-}" "${ELGATO_ACTION_CONTEXT-}")
    valid_identity "${identity[1]}" || fail
    valid_identity "${identity[2]}" || fail
    valid_identity "${identity[3]}" || fail
fi
digest_output=$(
    for part in "${identity[@]}"; do
        printf '%s:%s' "${#part}" "$part" || exit 1
    done | /usr/bin/shasum -a 256 2>/dev/null
) || fail
digest=${digest_output:0:64}
[[ ${#digest} -eq 64 && "$digest" != *[!0123456789abcdef]* ]] || fail

temp_base=${TMPDIR:-/tmp}
[[ "$temp_base" == /* && -d "$temp_base" ]] || fail
root=${temp_base%/}/stream-canvas-counter-sh-$UID
if [[ ! -e "$root" && ! -L "$root" ]]; then
    # Another invocation may create the directory first.
    /bin/mkdir -m 700 "$root" 2>/dev/null || :
fi
[[ -d "$root" && ! -L "$root" ]] || fail
# Pin later relative accesses, then validate the directory actually entered.
cd -P -- "$root" 2>/dev/null || fail
[[ -O . ]] || fail
directory_mode=$(/usr/bin/stat -f '%Lp' . 2>/dev/null) || fail
[[ -n "$directory_mode" && "$directory_mode" != *[!0-7]* ]] || fail
(( (8#$directory_mode & 077) == 0 )) || fail
root=.

state=$root/$digest.state
lock=$root/$digest.lock
lock_owned=false
staging=''
cleanup() {
    local status=$?
    trap - EXIT
    trap '' HUP INT TERM
    if [[ -n "$staging" ]]; then
        /bin/rm -f "$staging" 2>/dev/null || status=1
    fi
    if [[ "$lock_owned" == true ]]; then
        /bin/rmdir "$lock" 2>/dev/null || status=1
    fi
    if (( status != 0 )); then
        # Failures may already have printed the same fixed diagnostic.
        printf 'Counter failed.\n' >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
/bin/mkdir -m 700 "$lock" 2>/dev/null && lock_owned=true
[[ "$lock_owned" == true ]] || fail

count=0
if [[ -e "$state" || -L "$state" ]]; then
    [[ -f "$state" && ! -L "$state" ]] || fail
    state_bytes=$(wc -c < "$state" 2>/dev/null) || fail
    (( state_bytes >= 2 && state_bytes <= 10 )) || fail
    # Require exactly one LF-terminated record. Size also rejects discarded NULs.
    {
        IFS= read -r count &&
        ! IFS= read -r extra && [[ -z "$extra" ]]
    } 2>/dev/null < "$state" || fail
    [[ -n "$count" && "$count" != *[!0123456789]* && ${#count} -le 9 ]] || fail
    [[ "$count" == 0 || "$count" != 0* ]] || fail
    (( state_bytes == ${#count} + 1 )) || fail
fi
(( count < MAX_COUNT )) || fail
next=$((count + 1))
staging=$(/usr/bin/mktemp "$root/$digest.stage.XXXXXXXX" 2>/dev/null) || fail
[[ "$staging" == "$root/$digest.stage."* && -f "$staging" && ! -L "$staging" ]] || fail
{ printf '%s\n' "$next" > "$staging"; } 2>/dev/null || fail
# mv would move into a directory, so check the destination again before rename.
if [[ -e "$state" || -L "$state" ]]; then
    [[ -f "$state" && ! -L "$state" ]] || fail
fi
/bin/mv -f "$staging" "$state" 2>/dev/null || fail
staging=''
printf 'text:%s|font:mono;weight:bold;font-size:auto;background:#090D18;border:3\n' "$next" 2>/dev/null || fail
