//! The file handling every store family in this module shares.
//!
//! Reading never fails the app: a file that cannot be read or cannot be parsed
//! is one `warn!` and the defaults. Writing publishes a whole file or nothing:
//! the content lands in a same-directory `.tmp`, is pushed to the disk, and only
//! then is renamed over the target.

use std::fs;

use log::warn;
use serde::{Deserialize, Serialize};

/// Parse the contents of one config file, falling back to the default when they
/// are not this schema's JSON.
///
/// The fallback is deliberate: a config that cannot be read must not keep the
/// app from starting. What it must not be is *silent* — discarding every
/// remembered route or delay without a line anywhere is indistinguishable from
/// the feature being broken, and the difference matters because the file is
/// still on disk for the user to look at. A rename, a truncation or a hand
/// edit are all recoverable once someone knows which file to open.
fn parse_or_default<T>(path: &std::path::Path, content: &str) -> T
where
    T: Default + for<'de> Deserialize<'de>,
{
    match serde_json::from_str::<T>(content) {
        Ok(map) => map,
        Err(e) => {
            warn!(
                "config {} does not parse ({e}); falling back to defaults and leaving the file as it is",
                path.display()
            );
            T::default()
        }
    }
}

/// Read one config file into its map, never failing.
///
/// A file that cannot be *read* goes the same way as a file that cannot be
/// parsed: one `warn!` and the defaults. That is not a hypothetical — an
/// antivirus scan or a cloud-sync placeholder can hold the file open at the
/// moment the app starts, and refusing to launch over it would leave the user
/// with no window to explain anything and no settings page to open. A file that
/// simply isn't there is a first run and says nothing.
pub(super) fn read_or_default<T>(path: &std::path::Path) -> T
where
    T: Default + for<'de> Deserialize<'de>,
{
    match fs::read_to_string(path) {
        Ok(content) => parse_or_default(path, &content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => T::default(),
        Err(e) => {
            warn!(
                "config {} could not be read ({e}); falling back to defaults",
                path.display()
            );
            T::default()
        }
    }
}

/// Serialize `value` as pretty JSON and write it to `path`, creating parent
/// directories as needed.
///
/// The write is atomic and durable in that order: the content lands in a
/// same-directory `.tmp` file, that file is pushed to the disk, and only then is
/// it renamed over the target. Renaming within one directory is atomic on all
/// supported filesystems, so a crash never leaves a half-written config; the
/// flush is what keeps the *power* from doing the same. Without it the rename can
/// reach the disk before the bytes do, and the machine comes back to a target
/// file that exists and is empty — which `read_or_default` answers with a warning
/// and the defaults, so the user's remembered routes, delays and levels are gone
/// while the file that used to hold them looks untouched. Configs are written on
/// user actions, not in any hot path, so the extra flush is paid where nobody
/// hears it.
pub(crate) fn persist_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp");
    write_and_sync(&tmp, &content).map_err(|e| format!("write config failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup of the temp file; the real error is the rename.
        let _ = fs::remove_file(&tmp);
        format!("commit config failed: {e}")
    })?;
    Ok(())
}

/// Write the whole of `content` to `path` and wait for the disk to have it.
///
/// `sync_all` is `FlushFileBuffers` on Windows: it asks the volume, not just the
/// cache manager. A path already holding a file is replaced, and a write that
/// fails part way leaves only the `.tmp` — never the target.
fn write_and_sync(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::File::create(path)?;
    file.write_all(content.as_bytes())?;
    file.flush()?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::config::delays::DelayMap;
    use crate::config::route_memory::{DeviceList, RouteMap};

    #[test]
    fn an_unparsable_config_falls_back_to_the_default() {
        // The half that can be asserted here is the fallback: a truncated or
        // hand-edited file must not stop the app from starting. The other half
        // — that it says so — is the warning `parse_or_default` logs.
        let path = std::path::Path::new("route-memory.json");
        let map: RouteMap = parse_or_default(path, "{\"routes\": ");
        assert!(map.routes.is_empty());
    }

    #[test]
    fn a_schema_mismatch_falls_back_rather_than_partially_loading() {
        // A file of the right shape but the wrong types is the likeliest real
        // case: a delay written as a string, a volume as a float. Half of it
        // loading would leave the app running on numbers nobody chose.
        let path = std::path::Path::new("device-delays.json");
        let map: DelayMap = parse_or_default(path, r#"{"delays": {"dev": "soon"}}"#);
        assert!(map.delays.is_empty());
    }

    /// A config write publishes a whole file or nothing. The rename is what makes
    /// it atomic; the flush before it is what keeps a power loss from publishing
    /// an empty target whose defaults would then be read back as the user's
    /// settings. What a test can pin here is the shape of the published file: the
    /// whole content, parseable, with no `.tmp` left beside it to be mistaken for
    /// a half-write.
    #[test]
    fn a_config_write_publishes_the_whole_file_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("aar-persist-{}", std::process::id()));
        let path = dir.join("route-memory.json");
        let mut map = RouteMap::default();
        map.routes.insert(
            "game.exe".to_string(),
            DeviceList(vec!["device".to_string()]),
        );

        persist_json(&path, &map).unwrap();

        let written = fs::read_to_string(&path).unwrap();
        let back: RouteMap = serde_json::from_str(&written).unwrap();
        assert_eq!(back.routes["game.exe"].0, vec!["device".to_string()]);
        assert!(
            !dir.join("route-memory.tmp").exists(),
            "the temporary goes with the rename"
        );
        // Writing over a file that already exists replaces it whole.
        map.routes
            .insert("other.exe".to_string(), DeviceList(vec!["b".to_string()]));
        persist_json(&path, &map).unwrap();
        let back: RouteMap = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.routes.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
