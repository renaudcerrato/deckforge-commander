#!/bin/sh
# Stream CPU: whole-machine busy percentage, not a per-process/core total.
LC_ALL=C
export LC_ALL

fail() {
    printf 'CPU metrics unavailable.\n' >&2
    exit 1
}

while true; do
    # A finite pair avoids overlapping top children. Discard the startup sample.
    samples=$(/usr/bin/top -l 2 -s 1 -n 0 -c n -F -R 2>/dev/null) || fail
    busy=$(/usr/bin/awk '
        /^CPU usage:/ {
            count++
            if (count != 2) next
            if (NF != 8 || $4 != "user," || $6 != "sys," || $8 != "idle") next
            if ($7 !~ /^[0-9]+([.][0-9]+)?%$/) next
            idle = $7
            sub(/%$/, "", idle)
            if (idle + 0 > 100) next
            # Ignore top decimal digits: some versions do not zero-pad them.
            split(idle, parts, /[.]/)
            value = 100 - parts[1]
            valid = 1
        }
        END {
            if (count != 2 || !valid) exit 1
            printf "%d", value
        }
    ' 2>/dev/null <<EOF
$samples
EOF
    ) || fail
    printf 'progress:%s|label:CPU;value-size:28;label-size:20;thickness:12\n' "$busy" || fail
done
