#!/bin/bash
# Stream local video as image records. macOS Bash 3.2; requires FFmpeg.
# Defaults: sample.mp4 beside this script, 10 FPS, play once. See --help.
# Use trusted media; file-protocol restrictions are not a sandbox.

set -o pipefail

readonly FRAME_BYTES=62208       # 144 * 144 * 3 RGB bytes
readonly FRAME_BASE64_BYTES=82944
readonly MAX_PNG_BASE64_BYTES=262122 # 262144 minus data URI prefix (22 bytes)

fail() {
    failure_code=$1
    printf 'video: %s\n' "$1" >&2
    return 1
}

stop_error_wait() {
    kill "$error_wait_pid" 2>/dev/null
    wait "$error_wait_pid" 2>/dev/null
    exit 1
}

show_key_error() {
    local message error_wait_pid
    [[ "${ELGATO_PLUGIN_UUID:-}" == git.renaudcerrato.deckforge ]] || return 1
    case "$failure_code" in
        FFMPEG_UNAVAILABLE) message='FFmpeg missing' ;;
        INPUT_REQUIRED|INPUT_UNAVAILABLE) message='Video missing' ;;
        BASE64_DECODER_UNAVAILABLE|VIDEO_PIPELINE_FAILED) message='Playback failed' ;;
        *) return 1 ;;
    esac
    printf 'text:%s\n' "$message" || return 1
    # Report only after the pipeline has finished; never put text into its raw bytes.
    sleep 5 &
    error_wait_pid=$!
    trap stop_error_wait INT TERM
    wait "$error_wait_pid"
    trap - INT TERM
    return 1
}

usage() {
    # Help also uses stderr: stdout is reserved exclusively for image records.
    printf '%s\n' \
        'Usage: ./video.sh [/path/to/clip.mp4] [--fps FPS] [--duration SECONDS] [--loop] [--ffmpeg /absolute/path/ffmpeg]' \
        '  clip      Local file; defaults to sample.mp4 beside this script.' \
        '  --ffmpeg  Absolute executable path; defaults to ffmpeg in PATH.' \
        '  --fps     1..20 (default 10); actual playback may be slower.' \
        '  --duration  0.1..120 seconds, up to 3 decimal places; omitted means uncapped.' \
        '              Limits total source output, including repeats with --loop.' \
        '  --loop    Repeat until stopped; otherwise play once.' \
        '  --help    Print help to stderr.' \
        'Requires dd, base64, tr, and FFmpeg with PNG/rawvideo and scale=reset_sar.' >&2
}

parse_options() {
    ffmpeg=''
    ffmpeg_override=false
    clip=''
    clip_seen=false
    fps=10
    duration=''
    duration_seen=false
    duration_options=()
    loop_options=()
    help_requested=false

    while (( $# > 0 )); do
        case "$1" in
            --ffmpeg|--fps|--duration)
                if (( $# < 2 )); then
                    fail 'OPTION_VALUE_REQUIRED'
                    return 1
                fi
                case "$1" in
                    --ffmpeg) ffmpeg=$2; ffmpeg_override=true ;;
                    --fps) fps=$2 ;;
                    --duration)
                        if [[ "$duration_seen" == true ]]; then
                            fail 'DURATION_DUPLICATE'
                            return 1
                        fi
                        duration=$2
                        duration_seen=true
                        ;;
                esac
                shift 2
                ;;
            --loop) loop_options=(-stream_loop -1); shift ;;
            --help|-h) help_requested=true; shift ;;
            -*) fail 'OPTION_INVALID'; return 1 ;;
            *)
                if [[ "$clip_seen" == true ]]; then
                    fail 'INPUT_DUPLICATE'
                    return 1
                fi
                clip=$1
                clip_seen=true
                shift
                ;;
        esac
    done
}

validate_duration() {
    local whole fraction milliseconds
    if [[ "$duration_seen" == false ]]; then
        return 0
    fi
    if [[ ! "$duration" =~ ^([0-9]{1,3})([.]([0-9]{1,3}))?$ ]]; then
        fail 'DURATION_INVALID'
        return 1
    fi
    whole=${BASH_REMATCH[1]}
    fraction=${BASH_REMATCH[3]}
    fraction="${fraction}000"
    fraction=${fraction:0:3}
    milliseconds=$((10#$whole * 1000 + 10#$fraction))
    if (( milliseconds < 100 || milliseconds > 120000 )); then
        fail 'DURATION_INVALID'
        return 1
    fi
    duration_options=(-t "$duration")
}

validate_options() {
    local script_directory
    validate_duration || return 1
    if [[ "$clip_seen" == false ]]; then
        case "${BASH_SOURCE[0]}" in
            */*) script_directory=${BASH_SOURCE[0]%/*} ;;
            *) script_directory=. ;;
        esac
        if ! script_directory=$(CDPATH= cd -- "$script_directory" 2>/dev/null && pwd -P) \
            || [[ ! -f "$script_directory/sample.mp4" ]]; then
            fail 'INPUT_REQUIRED'
            return 1
        fi
        clip="$script_directory/sample.mp4"
    fi
    if [[ -z "$clip" ]]; then
        fail 'INPUT_REQUIRED'
        return 1
    fi
    case "$clip" in
        /*) ;;
        *) clip="$PWD/$clip" ;;
    esac
    case "$fps" in
        [1-9]|1[0-9]|20) ;;
        *) fail 'FPS_INVALID'; return 1 ;;
    esac
    if [[ "$ffmpeg_override" == true ]]; then
        case "$ffmpeg" in
            /*) ;;
            *) fail 'FFMPEG_ABSOLUTE_PATH_REQUIRED'; return 1 ;;
        esac
    else
        # Runtime executable-only lookup; do not invoke aliases or functions.
        if ! ffmpeg=$(type -P ffmpeg 2>/dev/null) || [[ -z "$ffmpeg" ]]; then
            fail 'FFMPEG_UNAVAILABLE'
            return 1
        fi
        case "$ffmpeg" in
            /*) ;;
            *) ffmpeg="$PWD/$ffmpeg" ;;
        esac
    fi
    if [[ ! -f "$ffmpeg" || ! -x "$ffmpeg" ]]; then
        fail 'FFMPEG_UNAVAILABLE'
        return 1
    fi
    if [[ ! -f "$clip" || ! -r "$clip" ]]; then
        fail 'INPUT_UNAVAILABLE'
        return 1
    fi
}

choose_base64_decoder() {
    local flag probe
    # Probe only fixed synthetic data at user launch; no media or metadata.
    for flag in --decode -D -d; do
        if probe=$( { printf '%s' 'YQ==' | base64 "$flag"; } 2>/dev/null); then
            if [[ "$probe" == a ]]; then
                decode_flags=("$flag")
                return 0
            fi
        fi
    done
    fail 'BASE64_DECODER_UNAVAILABLE'
}

decode_video() {
    # Input options precede -i. Output is headerless, fixed-size RGB24 frames.
    # Fill the square without distortion; crop excess sides or top/bottom centrally.
    "$ffmpeg" -nostdin -hide_banner -loglevel error \
        -protocol_whitelist file "${loop_options[@]}" -re -i "$clip" \
        -map 0:v:0 -an -sn -dn \
        -vf "fps=fps=$fps,scale=144:144:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,crop=144:144:(iw-ow)/2:(ih-oh)/2,format=rgb24" \
        "${duration_options[@]}" -f rawvideo -pix_fmt rgb24 pipe:1 2>/dev/null
}

encode_png() {
    # Keep binary/NUL bytes out of Bash variables; decode straight into FFmpeg.
    { printf '%s' "$1" |
        base64 "${decode_flags[@]}" |
        "$ffmpeg" -nostdin -hide_banner -loglevel error \
            -protocol_whitelist pipe -f rawvideo -pixel_format rgb24 \
            -video_size 144x144 -framerate "$fps" -i pipe:0 \
            -frames:v 1 -c:v png -f image2pipe pipe:1 |
        base64 | tr -d '\r\n'; } 2>/dev/null
}

emit_frames() {
    local raw64 png64 saw_frame=false
    while :; do
        # Byte-sized input avoids crossing frames; the length check catches partial EOF.
        if ! raw64=$( { dd ibs=1 obs="$FRAME_BYTES" count="$FRAME_BYTES" |
            base64 | tr -d '\r\n'; } 2>/dev/null); then
            fail 'FRAME_READ_FAILED'
            return 1
        fi
        if [[ -z "$raw64" ]]; then
            if [[ "$saw_frame" == false ]]; then
                fail 'NO_VIDEO_FRAMES'
                return 1
            fi
            return 0
        fi
        if (( ${#raw64} != FRAME_BASE64_BYTES )); then
            fail 'FRAME_INCOMPLETE'
            return 1
        fi
        if ! png64=$(encode_png "$raw64"); then
            fail 'PNG_ENCODING_FAILED'
            return 1
        fi
        case "$png64" in
            ''|*[!A-Za-z0-9+/=]*) fail 'PNG_ENCODING_INVALID'; return 1 ;;
        esac
        if (( ${#png64} > MAX_PNG_BASE64_BYTES )); then
            fail 'PNG_RECORD_TOO_LARGE'
            return 1
        fi
        if ! printf 'data:image/png;base64,%s\n' "$png64"; then
            fail 'OUTPUT_FAILED'
            return 1
        fi
        saw_frame=true
    done
}

main() {
    parse_options "$@" || return 1
    if [[ "$help_requested" == true ]]; then
        usage
        return 0
    fi
    validate_options || return 1
    choose_base64_decoder || return 1
    if ! decode_video | emit_frames; then
        fail 'VIDEO_PIPELINE_FAILED'
        return 1
    fi
}

if ! main "$@"; then
    show_key_error
    exit 1
fi
