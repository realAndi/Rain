#![allow(unused_imports)]

pub mod config;
pub mod session;
pub mod tmux;
pub mod transfer;
pub mod window;

// Re-export all commands for external use (e.g. ipc::commands::create_session)
pub use config::{
    get_app_version,
    load_workspace,
    read_config_file,
    save_text_to_file,
    save_workspace,
    write_config_file,
};
pub use session::{
    create_session,
    destroy_session,
    get_block_output,
    request_full_redraw,
    resize_terminal,
    write_input,
};
pub use tmux::{
    tmux_close_pane,
    tmux_detach,
    tmux_list_sessions,
    tmux_new_window,
    tmux_resize_pane,
    tmux_select_pane,
    tmux_send_command,
    tmux_send_keys,
    tmux_split_pane,
    tmux_start,
};
pub use transfer::{
    commit_tab_transfer_adopt,
    emit_cross_window,
    list_rain_windows,
    prepare_tab_transfer_adopt,
    release_tab_transfer_adopt,
    stage_session_transfer_state,
    stage_tab_transfer_manifest,
    take_session_transfer_state,
    take_tab_transfer_manifest,
};
pub use window::{
    close_drag_ghost,
    create_child_window,
    create_drag_ghost,
    get_hostname,
    quit_app,
    register_global_hotkey,
    set_app_icon,
    set_window_blur_radius,
    set_window_opacity,
    toggle_window_visibility,
};
