use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

pub fn config_lock_path(config_path: &Path) -> Result<PathBuf, String> {
    if !config_path.is_absolute() {
        return Err("config path must be absolute before locking".into());
    }
    let parent = config_path
        .parent()
        .ok_or("config path has no parent directory")?
        .canonicalize()
        .map_err(|error| format!("cannot resolve config directory: {error}"))?;
    let name = config_path
        .file_name()
        .ok_or("config path has no file name")?;
    let mut lock_name = name.to_os_string();
    lock_name.push(".lock");
    Ok(parent.join(lock_name))
}

pub fn resolve_config_path(
    args: &[OsString],
    cwd: &Path,
    development_config: Option<&Path>,
    debug_assertions: bool,
) -> Result<PathBuf, String> {
    if !cwd.is_absolute() {
        return Err("process working directory must be absolute".into());
    }

    let mut selected = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == OsStr::new("--config") {
            if selected.is_some() {
                return Err("--config may only be provided once".into());
            }
            let value = args.get(index + 1).ok_or("--config requires a path")?;
            if value.is_empty() || value.to_string_lossy().starts_with("--") {
                return Err("--config requires a path".into());
            }
            selected = Some(value.as_os_str());
            index += 2;
        } else {
            index += 1;
        }
    }

    if let Some(value) = selected {
        let path = PathBuf::from(value);
        return Ok(if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        });
    }

    let project_config = cwd.join(".slidev-stage/local-config.json");
    if project_config.is_file() {
        return Ok(project_config);
    }
    if debug_assertions {
        if let Some(path) = development_config.filter(|path| path.is_file()) {
            if !path.is_absolute() {
                return Err("development config path must be absolute".into());
            }
            return Ok(path.to_path_buf());
        }
    }
    Err(
        "no Stage config found; pass --config <path> or create .slidev-stage/local-config.json"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::resolve_config_path;
    use std::{ffi::OsString, fs, path::Path};
    use tempfile::tempdir;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn keeps_absolute_config_independent_of_working_directory() {
        let temp = tempdir().unwrap();
        let cwd = temp.path().join("empty-cwd");
        let config = temp.path().join("project/config.json");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, "{}").unwrap();

        assert_eq!(
            resolve_config_path(
                &args(&["--config", config.to_str().unwrap()]),
                &cwd,
                None,
                true
            )
            .unwrap(),
            config
        );
    }

    #[test]
    fn anchors_relative_config_to_process_working_directory() {
        let temp = tempdir().unwrap();
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        assert_eq!(
            resolve_config_path(&args(&["--config", "config/local.json"]), &cwd, None, true)
                .unwrap(),
            cwd.join("config/local.json")
        );
    }

    #[test]
    fn rejects_repeated_and_missing_config_arguments() {
        let temp = tempdir().unwrap();
        let repeated = resolve_config_path(
            &args(&["--config", "a.json", "--config", "b.json"]),
            temp.path(),
            None,
            true,
        );
        assert!(repeated.unwrap_err().contains("only be provided once"));

        let missing = resolve_config_path(&args(&["--config"]), temp.path(), None, true);
        assert!(missing.unwrap_err().contains("requires a path"));
    }

    #[test]
    fn prefers_project_config_and_uses_development_fallback_only_in_debug() {
        let temp = tempdir().unwrap();
        let cwd = temp.path().join("project");
        let project = cwd.join(".slidev-stage/local-config.json");
        let development = temp.path().join("apps/slive/artifacts/local-config.json");
        fs::create_dir_all(project.parent().unwrap()).unwrap();
        fs::create_dir_all(development.parent().unwrap()).unwrap();
        fs::write(&project, "{}").unwrap();
        fs::write(&development, "{}").unwrap();
        assert_eq!(
            resolve_config_path(&[], &cwd, Some(&development), true).unwrap(),
            project
        );

        fs::remove_file(&project).unwrap();
        assert_eq!(
            resolve_config_path(&[], &cwd, Some(&development), true).unwrap(),
            development
        );
        let release = resolve_config_path(&[], &cwd, Some(&development), false);
        assert!(release.unwrap_err().contains("no Stage config found"));
    }

    #[test]
    fn ignores_missing_project_and_development_configs() {
        let temp = tempdir().unwrap();
        let cwd = temp.path().join("empty");
        fs::create_dir_all(&cwd).unwrap();
        let missing_development = Path::new("/no/such/stage-config.json");
        assert!(resolve_config_path(&[], &cwd, Some(missing_development), true).is_err());
    }
}
