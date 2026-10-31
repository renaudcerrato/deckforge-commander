#!/bin/sh
# One snapshot per invocation; Loop owns the refresh interval.
if [ "${ELGATO_ACTION_UUID-}" != 'git.renaudcerrato.deckforge.loop' ]; then
    printf 'Use a Loop key\n'
    exit 0
fi

fail() {
    printf 'Disk metrics unavailable.\n' >&2
    exit 1
}

[ "$#" -le 1 ] || fail
target=${1-/}
[ -d "$target" ] || fail
case "$target" in
    /*) ;;
    *) target=./$target ;;
esac

# Keep the query status separate from parsing; never turn a failed query into zero.
snapshot=$(LC_ALL=C /bin/df -k -P "$target" 2>/dev/null) || fail
record=$(printf '%s\n' "$snapshot" | LC_ALL=C /usr/bin/awk '
    NR == 2 && NF >= 6 && $4 ~ /^[0-9]+$/ { available = $4; valid = 1 }
    END {
        if (NR != 2 || !valid) exit 1
        printf "text:%.1f|label:GiB free\n", available / 1048576
    }
' 2>/dev/null) || fail
printf '%s\n' "$record"
exit 0
