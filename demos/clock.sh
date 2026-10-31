#!/bin/sh
# Stream clock: tap the key to start or stop the cyan local time display.
while true; do
    printf 'text:%s|color:cyan\n' "$(date '+%H:%M:%S')"
    sleep 1
done
