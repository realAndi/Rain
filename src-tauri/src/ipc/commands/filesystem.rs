use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let read = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|ft| ft.is_dir())
            .unwrap_or(false);
        entries.push(DirEntry { name, is_dir });
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

// ---------------------------------------------------------------------------
// scan_project_commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    pub name: String,
    pub runner: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommands {
    pub scripts: Vec<ProjectScript>,
    pub project_type: Option<String>,
}

#[tauri::command]
pub fn scan_project_commands(cwd: String) -> Result<ProjectCommands, String> {
    let mut scripts: Vec<ProjectScript> = Vec::new();
    let mut project_type: Option<String> = None;
    let mut found_types: HashSet<String> = HashSet::new();

    // Walk up to 5 levels looking for project files
    let mut dir = PathBuf::from(&cwd);
    for _ in 0..5 {
        if !found_types.contains("node") {
            if let Some(mut s) = scan_package_json(&dir) {
                scripts.append(&mut s);
                found_types.insert("node".into());
                if project_type.is_none() {
                    project_type = Some("node".into());
                }
            }
        }
        if !found_types.contains("rust") {
            if let Some(mut s) = scan_cargo_toml(&dir) {
                scripts.append(&mut s);
                found_types.insert("rust".into());
                if project_type.is_none() {
                    project_type = Some("rust".into());
                }
            }
        }
        if !found_types.contains("make") {
            if let Some(mut s) = scan_makefile(&dir) {
                scripts.append(&mut s);
                found_types.insert("make".into());
                if project_type.is_none() {
                    project_type = Some("make".into());
                }
            }
        }
        if !found_types.contains("python") {
            if let Some(mut s) = scan_python_project(&dir) {
                scripts.append(&mut s);
                found_types.insert("python".into());
                if project_type.is_none() {
                    project_type = Some("python".into());
                }
            }
        }
        if !found_types.contains("taskfile") {
            if let Some(mut s) = scan_taskfile(&dir) {
                scripts.append(&mut s);
                found_types.insert("taskfile".into());
            }
        }

        if !dir.pop() {
            break;
        }
    }

    Ok(ProjectCommands {
        scripts,
        project_type,
    })
}

fn scan_package_json(dir: &Path) -> Option<Vec<ProjectScript>> {
    let pkg = dir.join("package.json");
    let content = std::fs::read_to_string(&pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let scripts_obj = json.get("scripts")?.as_object()?;

    // Detect package manager by lockfile
    let runner = if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun run"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("pnpm-lock.yaml").exists() {
        "pnpm run"
    } else {
        "npm run"
    };

    // Runners that support shorthand (e.g. `bun dev` instead of `bun run dev`)
    let shorthand_runner: Option<&str> = match runner {
        "bun run" => Some("bun"),
        "pnpm run" => Some("pnpm"),
        _ => None,
    };

    let mut result = Vec::new();
    for key in scripts_obj.keys() {
        result.push(ProjectScript {
            name: key.clone(),
            runner: runner.into(),
        });
        if let Some(short) = shorthand_runner {
            result.push(ProjectScript {
                name: key.clone(),
                runner: short.into(),
            });
        }
    }
    Some(result)
}

fn scan_cargo_toml(dir: &Path) -> Option<Vec<ProjectScript>> {
    let cargo = dir.join("Cargo.toml");
    if !cargo.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&cargo).ok()?;

    let mut result = vec![
        ProjectScript { name: "build".into(), runner: "cargo".into() },
        ProjectScript { name: "run".into(), runner: "cargo".into() },
        ProjectScript { name: "test".into(), runner: "cargo".into() },
        ProjectScript { name: "check".into(), runner: "cargo".into() },
        ProjectScript { name: "clippy".into(), runner: "cargo".into() },
        ProjectScript { name: "fmt".into(), runner: "cargo".into() },
        ProjectScript { name: "bench".into(), runner: "cargo".into() },
        ProjectScript { name: "doc".into(), runner: "cargo".into() },
        ProjectScript { name: "clean".into(), runner: "cargo".into() },
    ];

    // Extract [[bin]] target names
    let mut in_bin = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[[bin]]" {
            in_bin = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_bin = false;
            continue;
        }
        if in_bin {
            if let Some(rest) = trimmed.strip_prefix("name") {
                let rest = rest.trim_start().strip_prefix('=').unwrap_or("").trim();
                let name = rest.trim_matches('"').trim_matches('\'');
                if !name.is_empty() {
                    result.push(ProjectScript {
                        name: format!("run --bin {}", name),
                        runner: "cargo".into(),
                    });
                }
            }
        }
    }

    Some(result)
}

fn scan_makefile(dir: &Path) -> Option<Vec<ProjectScript>> {
    let makefile = ["Makefile", "makefile", "GNUmakefile"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())?;
    let content = std::fs::read_to_string(&makefile).ok()?;

    let mut result = Vec::new();
    for line in content.lines() {
        // Match target lines: `target-name:` (not starting with tab/space, not starting with .)
        if let Some(colon_idx) = line.find(':') {
            let target = &line[..colon_idx];
            if target.is_empty() || target.starts_with(|c: char| c.is_whitespace() || c == '.' || c == '#') {
                continue;
            }
            // Skip targets with special chars (variables, etc.)
            if target.contains('$') || target.contains('%') || target.contains('=') {
                continue;
            }
            let target = target.trim();
            if !target.is_empty() && target.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                result.push(ProjectScript {
                    name: target.to_string(),
                    runner: "make".into(),
                });
            }
        }
    }
    Some(result)
}

fn scan_python_project(dir: &Path) -> Option<Vec<ProjectScript>> {
    let has_pyproject = dir.join("pyproject.toml").exists();
    let has_requirements = dir.join("requirements.txt").exists();
    let has_setup = dir.join("setup.py").exists();

    if !has_pyproject && !has_requirements && !has_setup {
        return None;
    }

    let mut result = vec![
        ProjectScript { name: "pip install".into(), runner: "python -m".into() },
        ProjectScript { name: "pip install -r requirements.txt".into(), runner: "python -m".into() },
    ];

    if has_pyproject {
        let content = std::fs::read_to_string(dir.join("pyproject.toml")).unwrap_or_default();
        if content.contains("[tool.pytest") {
            result.push(ProjectScript { name: "pytest".into(), runner: "python -m".into() });
        }
        if content.contains("[tool.mypy") {
            result.push(ProjectScript { name: "mypy .".into(), runner: "python -m".into() });
        }
        if content.contains("[tool.ruff") || content.contains("ruff") {
            result.push(ProjectScript { name: "ruff check .".into(), runner: "".into() });
            result.push(ProjectScript { name: "ruff format .".into(), runner: "".into() });
        }
        if content.contains("[tool.black") {
            result.push(ProjectScript { name: "black .".into(), runner: "python -m".into() });
        }

        // Extract [project.scripts] entry points
        let mut in_scripts = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed == "[project.scripts]" {
                in_scripts = true;
                continue;
            }
            if trimmed.starts_with('[') {
                in_scripts = false;
                continue;
            }
            if in_scripts {
                if let Some(eq_idx) = trimmed.find('=') {
                    let name = trimmed[..eq_idx].trim().trim_matches('"').trim_matches('\'');
                    if !name.is_empty() {
                        result.push(ProjectScript {
                            name: name.to_string(),
                            runner: "".into(),
                        });
                    }
                }
            }
        }
    }

    Some(result)
}

fn scan_taskfile(dir: &Path) -> Option<Vec<ProjectScript>> {
    let taskfile = ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())?;
    let content = std::fs::read_to_string(&taskfile).ok()?;

    let mut result = Vec::new();
    let mut in_tasks = false;
    for line in content.lines() {
        let trimmed = line.trim();
        // Top-level `tasks:` key
        if trimmed == "tasks:" {
            in_tasks = true;
            continue;
        }
        if in_tasks {
            // Task names are indented exactly 2 spaces and end with ':'
            if line.starts_with("  ") && !line.starts_with("    ") {
                if let Some(name) = trimmed.strip_suffix(':') {
                    let name = name.trim();
                    if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ':') {
                        result.push(ProjectScript {
                            name: name.to_string(),
                            runner: "task".into(),
                        });
                    }
                }
            }
            // End of tasks block (another top-level key)
            if !line.starts_with(' ') && !trimmed.is_empty() && trimmed != "tasks:" {
                in_tasks = false;
            }
        }
    }
    Some(result)
}

// ---------------------------------------------------------------------------
// scan_path_commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn scan_path_commands() -> Result<Vec<String>, String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let dirs: Vec<&str> = path_var.split(sep).collect();

    let mut seen = HashSet::new();
    let mut commands = BTreeSet::new();
    const MAX_COMMANDS: usize = 5000;

    for dir_str in dirs {
        if dir_str.is_empty() {
            continue;
        }
        let dir = Path::new(dir_str);
        if !dir.is_dir() {
            continue;
        }
        // Skip duplicate PATH entries
        let canonical = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if !seen.insert(canonical) {
            continue;
        }

        let read = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for entry in read {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = entry.metadata() {
                    if meta.permissions().mode() & 0o111 == 0 {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            commands.insert(name);
            if commands.len() >= MAX_COMMANDS {
                break;
            }
        }
        if commands.len() >= MAX_COMMANDS {
            break;
        }
    }

    Ok(commands.into_iter().collect())
}

// ---------------------------------------------------------------------------
// snoop_path_context
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoopResult {
    pub files: Vec<String>,
    pub entry_points: Vec<String>,
    pub scripts: Vec<ProjectScript>,
}

#[tauri::command]
pub fn snoop_path_context(dir: String, runtime: String) -> Result<SnoopResult, String> {
    let dir_path = Path::new(&dir);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", dir));
    }

    let (extensions, well_known): (&[&str], &[&str]) = match runtime.as_str() {
        "python" | "python3" => (
            &[".py"],
            &["main.py", "app.py", "manage.py", "__main__.py", "setup.py", "run.py"],
        ),
        "node" => (
            &[".js", ".mjs", ".cjs", ".ts", ".mts"],
            &["index.js", "index.ts", "main.js", "server.js", "app.js", "index.mjs"],
        ),
        "deno" | "deno run" => (
            &[".ts", ".js", ".tsx", ".jsx"],
            &["main.ts", "mod.ts", "server.ts", "index.ts"],
        ),
        "bun" | "bun run" => (
            &[".ts", ".js", ".tsx", ".jsx"],
            &["index.ts", "index.tsx", "index.js", "main.ts", "server.ts", "app.ts"],
        ),
        "ruby" => (
            &[".rb"],
            &["main.rb", "app.rb", "config.ru"],
        ),
        "php" => (
            &[".php"],
            &["index.php", "artisan", "server.php"],
        ),
        "java" => (
            &[".java", ".jar"],
            &["Main.java"],
        ),
        "go run" => (
            &[".go"],
            &["main.go"],
        ),
        _ => (&[] as &[&str], &[] as &[&str]),
    };

    let mut files: Vec<String> = Vec::new();
    let mut entry_points: Vec<String> = Vec::new();
    let well_known_set: HashSet<&str> = well_known.iter().copied().collect();

    // Read directory, filter by extensions
    if let Ok(read) = std::fs::read_dir(dir_path) {
        for entry in read {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // Only include files (not directories) that match the runtime extensions
            let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let matches_ext = extensions.iter().any(|ext| name.ends_with(ext));
            if !matches_ext {
                continue;
            }
            if well_known_set.contains(name.as_str()) {
                entry_points.push(name.clone());
            }
            files.push(name);
        }
    }

    files.sort();
    entry_points.sort();

    // Check for package.json `main` field as entry point (node/bun/deno)
    if matches!(runtime.as_str(), "node" | "bun" | "bun run" | "deno" | "deno run") {
        if let Some(main) = read_package_json_main(dir_path) {
            if !entry_points.contains(&main) {
                entry_points.push(main);
            }
        }
    }

    // Parse project config for scripts
    let scripts = snoop_project_scripts(dir_path, &runtime);

    Ok(SnoopResult {
        files,
        entry_points,
        scripts,
    })
}

fn read_package_json_main(dir: &Path) -> Option<String> {
    let pkg = dir.join("package.json");
    let content = std::fs::read_to_string(&pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let main = json.get("main")?.as_str()?;
    if main.is_empty() {
        return None;
    }
    // Only return the filename if it doesn't contain path separators
    // (otherwise it's relative and the user would need to type the full path)
    let main_path = Path::new(main);
    if main_path.components().count() == 1 {
        Some(main.to_string())
    } else {
        Some(main.to_string())
    }
}

fn snoop_project_scripts(dir: &Path, runtime: &str) -> Vec<ProjectScript> {
    let mut scripts = Vec::new();

    match runtime {
        "node" | "bun" | "bun run" | "deno" | "deno run" => {
            // package.json scripts
            if let Some(pkg_scripts) = snoop_package_json_scripts(dir, runtime) {
                scripts.extend(pkg_scripts);
            }
            // deno.json tasks
            if matches!(runtime, "deno" | "deno run") {
                if let Some(deno_tasks) = snoop_deno_tasks(dir) {
                    scripts.extend(deno_tasks);
                }
            }
        }
        "python" | "python3" => {
            if let Some(py_scripts) = snoop_pyproject_scripts(dir) {
                scripts.extend(py_scripts);
            }
        }
        "ruby" => {
            // Check for Rakefile targets
            if let Some(rake_targets) = snoop_rakefile(dir) {
                scripts.extend(rake_targets);
            }
        }
        "php" => {
            if let Some(composer_scripts) = snoop_composer_scripts(dir) {
                scripts.extend(composer_scripts);
            }
        }
        _ => {}
    }

    scripts
}

fn snoop_package_json_scripts(dir: &Path, runtime: &str) -> Option<Vec<ProjectScript>> {
    let pkg = dir.join("package.json");
    let content = std::fs::read_to_string(&pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let scripts_obj = json.get("scripts")?.as_object()?;

    let runner = match runtime {
        "bun" | "bun run" => "bun run",
        _ => {
            if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
                "bun run"
            } else if dir.join("yarn.lock").exists() {
                "yarn"
            } else if dir.join("pnpm-lock.yaml").exists() {
                "pnpm run"
            } else {
                "npm run"
            }
        }
    };

    let shorthand: Option<&str> = match runner {
        "bun run" => Some("bun"),
        "pnpm run" => Some("pnpm"),
        _ => None,
    };

    let mut result = Vec::new();
    for key in scripts_obj.keys() {
        result.push(ProjectScript {
            name: key.clone(),
            runner: runner.into(),
        });
        if let Some(short) = shorthand {
            result.push(ProjectScript {
                name: key.clone(),
                runner: short.into(),
            });
        }
    }
    Some(result)
}

fn snoop_deno_tasks(dir: &Path) -> Option<Vec<ProjectScript>> {
    let deno_json = dir.join("deno.json");
    let deno_jsonc = dir.join("deno.jsonc");
    let path = if deno_json.exists() {
        deno_json
    } else if deno_jsonc.exists() {
        deno_jsonc
    } else {
        return None;
    };

    let content = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let tasks = json.get("tasks")?.as_object()?;

    let mut result = Vec::new();
    for key in tasks.keys() {
        result.push(ProjectScript {
            name: format!("task {}", key),
            runner: "deno".into(),
        });
    }
    Some(result)
}

fn snoop_pyproject_scripts(dir: &Path) -> Option<Vec<ProjectScript>> {
    let pyproject = dir.join("pyproject.toml");
    let content = std::fs::read_to_string(&pyproject).ok()?;

    let mut result = Vec::new();

    // Extract [project.scripts] entry points
    let mut in_scripts = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[project.scripts]" {
            in_scripts = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_scripts = false;
            continue;
        }
        if in_scripts {
            if let Some(eq_idx) = trimmed.find('=') {
                let name = trimmed[..eq_idx].trim().trim_matches('"').trim_matches('\'');
                if !name.is_empty() {
                    result.push(ProjectScript {
                        name: name.to_string(),
                        runner: "".into(),
                    });
                }
            }
        }
    }

    if result.is_empty() {
        return None;
    }
    Some(result)
}

fn snoop_rakefile(dir: &Path) -> Option<Vec<ProjectScript>> {
    let rakefile = dir.join("Rakefile");
    if !rakefile.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&rakefile).ok()?;

    let mut result = Vec::new();
    // Match `task :name` or `task 'name'` or `task "name"`
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("task") {
            let rest = rest.trim();
            let name = if let Some(n) = rest.strip_prefix(':') {
                n.split(|c: char| !c.is_alphanumeric() && c != '_').next()
            } else if rest.starts_with('\'') || rest.starts_with('"') {
                let quote = rest.chars().next().unwrap();
                rest[1..].split(quote).next()
            } else {
                None
            };
            if let Some(name) = name {
                let name = name.trim();
                if !name.is_empty() {
                    result.push(ProjectScript {
                        name: name.to_string(),
                        runner: "rake".into(),
                    });
                }
            }
        }
    }

    if result.is_empty() { None } else { Some(result) }
}

fn snoop_composer_scripts(dir: &Path) -> Option<Vec<ProjectScript>> {
    let composer = dir.join("composer.json");
    let content = std::fs::read_to_string(&composer).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let scripts = json.get("scripts")?.as_object()?;

    let mut result = Vec::new();
    for key in scripts.keys() {
        result.push(ProjectScript {
            name: key.clone(),
            runner: "composer".into(),
        });
    }
    if result.is_empty() { None } else { Some(result) }
}
