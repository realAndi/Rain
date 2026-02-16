pub mod reader;
pub mod session;

pub use session::Session;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use crate::shell::{detect::detect_shell, hooks::shell_init_command};

/// Result of spawning a session: the session itself plus the reader handle
/// which must be passed to the reader thread.
pub struct SpawnResult {
    pub session: Session,
    pub reader: Box<dyn std::io::Read + Send>,
}

/// Manages PTY creation and shell spawning.
/// Stateless: creates a new PtySystem for each spawn to avoid Sync issues.
pub struct PtyManager;

impl PtyManager {
    pub fn new() -> Self {
        Self
    }

    /// Spawn a new terminal session with the given shell and dimensions.
    pub fn spawn_session(
        &self,
        shell_path: Option<&str>,
        cwd: Option<&str>,
        rows: u16,
        cols: u16,
    ) -> Result<SpawnResult, Box<dyn std::error::Error + Send + Sync>> {
        let pty_system = native_pty_system();
        let shell = shell_path.map(String::from).unwrap_or_else(detect_shell);

        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&shell);

        if let Some(dir) = cwd {
            cmd.cwd(dir);
        } else if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("RAIN_TERMINAL", "1");
        cmd.env("LANG", "en_US.UTF-8");

        let shell_name = crate::shell::detect::shell_name(&shell);
        if let Some(init_cmd) = shell_init_command(shell_name) {
            cmd.env("RAIN_SHELL_INIT", &init_cmd);
            apply_shell_init(&mut cmd, shell_name, &init_cmd)?;
        } else {
            // Default to login shell when no integration is available
            cmd.arg("--login");
        }

        let child = pair.slave.spawn_command(cmd)?;
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let session = Session::new(pair.master, child, writer, rows, cols);

        Ok(SpawnResult { session, reader })
    }
}

fn apply_shell_init(
    cmd: &mut CommandBuilder,
    shell_name: &str,
    init_cmd: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match shell_name {
        "zsh" => {
            let dir = create_shell_init_dir("zsh")?;
            let zshrc = r#"
if [ -n "$RAIN_ORIG_ZDOTDIR" ] && [ -f "$RAIN_ORIG_ZDOTDIR/.zshrc" ]; then
  source "$RAIN_ORIG_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

if [ -n "$RAIN_SHELL_INIT" ]; then
  eval "$RAIN_SHELL_INIT"
fi
"#;
            let zprofile = r#"
if [ -n "$RAIN_ORIG_ZDOTDIR" ] && [ -f "$RAIN_ORIG_ZDOTDIR/.zprofile" ]; then
  source "$RAIN_ORIG_ZDOTDIR/.zprofile"
elif [ -f "$HOME/.zprofile" ]; then
  source "$HOME/.zprofile"
fi
"#;

            fs::write(dir.join(".zshrc"), zshrc)?;
            fs::write(dir.join(".zprofile"), zprofile)?;

            if let Ok(orig) = std::env::var("ZDOTDIR") {
                if !orig.is_empty() {
                    cmd.env("RAIN_ORIG_ZDOTDIR", orig);
                }
            }
            cmd.env("ZDOTDIR", dir);
            cmd.arg("--login");
        }
        "bash" => {
            let dir = create_shell_init_dir("bash")?;
            let bashrc = format!(
                r#"
if [ -f "$HOME/.bash_profile" ]; then
  source "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then
  source "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then
  source "$HOME/.profile"
fi
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi
if [ -n "$RAIN_SHELL_INIT" ]; then
  eval "$RAIN_SHELL_INIT"
fi
"#
            );
            let rc_path = dir.join("rain.bashrc");
            fs::write(&rc_path, bashrc)?;
            cmd.arg("--noprofile");
            cmd.arg("--rcfile");
            cmd.arg(rc_path);
        }
        "fish" => {
            cmd.arg("-C");
            cmd.arg(init_cmd);
        }
        _ => {
            cmd.arg("--login");
        }
    }

    Ok(())
}

fn create_shell_init_dir(shell_name: &str) -> Result<PathBuf, std::io::Error> {
    let dir = std::env::temp_dir().join(format!("rain-shell-{}-{}", shell_name, Uuid::new_v4()));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
