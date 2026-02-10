# Rain terminal - bash shell integration hooks
# Implements FinalTerm protocol (OSC 133) for command block detection.

# Guard: only run inside Rain
[[ -n "$RAIN_TERMINAL" ]] || return

__rain_cmd_active=""

__rain_before_prompt() {
    local last_status=$?

    # OSC 133;D - previous command finished
    if [[ -n "$__rain_cmd_active" ]]; then
        printf '\033]133;D;%d\007' "$last_status"
        __rain_cmd_active=""
    fi

    # OSC 7 - report current working directory
    printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"

    # OSC 133;A - prompt start
    printf '\033]133;A\007'
}

__rain_before_cmd() {
    # OSC 133;B - command identified
    printf '\033]133;B;%s\007' "$1"

    # OSC 133;C - command output starts
    printf '\033]133;C\007'

    __rain_cmd_active=1
}

# Hook into PROMPT_COMMAND for the before-prompt callback
__rain_saved_prompt_cmd="${PROMPT_COMMAND:-}"
PROMPT_COMMAND='__rain_before_prompt; '"${__rain_saved_prompt_cmd}"

# Use DEBUG trap for the before-command callback
__rain_trap_handler() {
    # Skip when inside prompt command or completion
    [[ -n "$COMP_LINE" ]] && return
    [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
    [[ -z "$__rain_cmd_active" ]] && __rain_before_cmd "$BASH_COMMAND"
}
trap '__rain_trap_handler' DEBUG
