# Rain terminal - zsh shell integration hooks
# Implements FinalTerm protocol (OSC 133) for command block detection.

# Guard: only run inside Rain
[[ -n "$RAIN_TERMINAL" ]] || return

__rain_before_prompt() {
    local last_status=$?

    # OSC 133;D - previous command finished (skip on first prompt)
    if [[ -n "$__rain_cmd_active" ]]; then
        printf '\033]133;D;%d\007' "$last_status"
        unset __rain_cmd_active
    fi

    # OSC 7 - report current working directory
    printf '\033]7;file://%s%s\007' "$HOST" "$PWD"

    # OSC 133;A - prompt start
    printf '\033]133;A\007'
}

__rain_before_cmd() {
    # OSC 133;B - command identified (with command text)
    printf '\033]133;B;%s\007' "$1"

    # OSC 133;C - command output starts
    printf '\033]133;C\007'

    __rain_cmd_active=1
}

# Suppress the shell's own prompt since Rain renders its own.
# Set in precmd too so frameworks like oh-my-zsh/p10k can't override it.
__rain_suppress_prompt() {
    PS1=""
    PS2=""
    RPS1=""
    RPS2=""
    PROMPT=""
    RPROMPT=""
}
__rain_suppress_prompt

# Register hooks (append, don't replace existing hooks).
# Prompt suppression runs first (prepend), then our OSC hooks.
precmd_functions=(__rain_suppress_prompt "${precmd_functions[@]}")
precmd_functions+=(__rain_before_prompt)
preexec_functions+=(__rain_before_cmd)
