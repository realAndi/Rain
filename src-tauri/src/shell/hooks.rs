use std::path::PathBuf;

/// Get the directory containing the shell hook scripts.
/// In development, this is src-tauri/shell-hooks/.
/// In a release build, hooks are bundled as resources.
pub fn hooks_dir() -> PathBuf {
    // For dev: use the source directory
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shell-hooks");
    if dev_path.exists() {
        return dev_path;
    }

    // Fallback: try relative to executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let resource_path = dir.join("shell-hooks");
            if resource_path.exists() {
                return resource_path;
            }
        }
    }

    dev_path
}

/// Get the hook script path for a given shell.
pub fn hook_script_path(shell_name: &str) -> Option<PathBuf> {
    let dir = hooks_dir();
    let filename = format!("rain.{}", shell_name);
    let path = dir.join(filename);

    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Build the shell command that sources our hooks.
/// This is injected into the shell's init via environment variables.
pub fn shell_init_command(shell_name: &str) -> Option<String> {
    let script = hook_script_path(shell_name)?;
    let script_str = script.to_string_lossy();

    match shell_name {
        "zsh" => Some(format!(
            r#"if [ -f "{script_str}" ]; then source "{script_str}"; fi"#
        )),
        "bash" => Some(format!(
            r#"if [ -f "{script_str}" ]; then source "{script_str}"; fi"#
        )),
        "fish" => Some(format!(
            r#"if test -f "{script_str}"; source "{script_str}"; end"#
        )),
        _ => None,
    }
}
