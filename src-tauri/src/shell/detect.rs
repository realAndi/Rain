use std::env;

/// Detect the user's default shell on macOS.
pub fn detect_shell() -> String {
    // Check SHELL environment variable first
    if let Ok(shell) = env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }

    // Fallback to zsh on macOS (it's the default since Catalina)
    "/bin/zsh".to_string()
}

/// Get the shell name from its full path (e.g. "/bin/zsh" -> "zsh").
pub fn shell_name(shell_path: &str) -> &str {
    shell_path.rsplit('/').next().unwrap_or(shell_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_name() {
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name("/usr/local/bin/fish"), "fish");
        assert_eq!(shell_name("bash"), "bash");
    }
}
