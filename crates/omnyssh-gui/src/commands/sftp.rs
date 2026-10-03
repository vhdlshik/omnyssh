//! SFTP session commands (tech-gui.md §4.2). `sftp_open` awaits the core connect and
//! spawns a per-session forwarder that stamps every `sftp-*` event with the tab's
//! session id (§3.4); the remote ops are thin `SftpCommand` enqueues whose results
//! arrive as events. Local filesystem listing/preview return directly — the GUI never
//! emits `LocalDirListed` (§4.3).

use tauri::{AppHandle, State};
use tokio::sync::mpsc;

use omnyssh_core::event::CoreEvent;
use omnyssh_core::ssh::identity;
use omnyssh_core::ssh::password::Prompter;
use omnyssh_core::ssh::sftp::{
    list_local_dir as core_list_local_dir, preview_local_file as core_preview_local_file,
    remove_local_tree, SftpCommand, SftpManager,
};

use crate::bridge;
use crate::dto::FileEntryDto;
use crate::error::CommandError;
use crate::state::GuiState;

/// A tab's dedicated core-event channel buffer. Comfortably absorbs the connect ack
/// plus a burst of transfer-progress ticks before the forwarder drains them (§3.4).
const SFTP_EVENT_BUFFER: usize = 256;

/// Open an SFTP session for `host_name` (tech-gui.md §4.2). Awaits the core connect,
/// registers the manager under a fresh public id, and spawns the per-session
/// forwarder; the `sftp-connected` ack then arrives stamped with that id (§3.4).
#[tauri::command]
#[specta::specta]
pub async fn sftp_open(
    app: AppHandle,
    state: State<'_, GuiState>,
    host_name: String,
) -> Result<u64, CommandError> {
    let host = state.host_by_name(&host_name).ok_or_else(|| CommandError {
        message: format!("unknown host '{host_name}'"),
    })?;
    // A dedicated channel per tab: its owner is the session id, so the forwarder can
    // attribute the core's session-less `sftp-*` events to this tab (§3.4).
    let (tx, rx) = mpsc::channel::<CoreEvent>(SFTP_EVENT_BUFFER);
    // The prompt goes out on the engine channel: this tab's own channel only
    // carries `sftp-*` events.
    let prompter = Prompter::new(state.engine_sender(), &host_name);
    let manager = match SftpManager::connect(&host, tx, prompter).await {
        Ok(manager) => manager,
        Err(e) => {
            if let Some(path) = omnyssh_core::ssh::session::passphrase_required(&e) {
                identity::ask_passphrase(&state.engine_sender(), &host_name, path).await;
            }
            // The whole chain: the core wraps the cause in "SFTP SSH connect".
            return Err(CommandError {
                message: format!("{e:#}"),
            });
        }
    };
    let session_id = state.register_sftp(manager);
    tauri::async_runtime::spawn(bridge::forward_sftp_events(app, session_id, rx));
    Ok(session_id)
}

/// List a remote directory (tech-gui.md §4.2); the result arrives as `sftp-dir-listed`.
#[tauri::command]
#[specta::specta]
pub fn sftp_list(
    state: State<'_, GuiState>,
    session_id: u64,
    path: String,
) -> Result<(), CommandError> {
    state.send_sftp(session_id, SftpCommand::ListDir(path));
    Ok(())
}

/// Upload a local file to a remote path (tech-gui.md §4.2). Allocates a transfer id
/// owned by this session so `transfer-progress` routes back to the tab (§3.4).
#[tauri::command]
#[specta::specta]
pub fn sftp_upload(
    state: State<'_, GuiState>,
    session_id: u64,
    local: String,
    remote: String,
) -> Result<(), CommandError> {
    let transfer_id = state.next_transfer(session_id);
    state.send_sftp(
        session_id,
        SftpCommand::Upload {
            local,
            remote,
            transfer_id,
        },
    );
    Ok(())
}

/// Download a remote file to a local path (tech-gui.md §4.2). See `sftp_upload` for
/// the transfer-id routing; the core guards the local destination against `..` (§3.2).
#[tauri::command]
#[specta::specta]
pub fn sftp_download(
    state: State<'_, GuiState>,
    session_id: u64,
    local: String,
    remote: String,
) -> Result<(), CommandError> {
    let transfer_id = state.next_transfer(session_id);
    state.send_sftp(
        session_id,
        SftpCommand::Download {
            remote,
            local,
            transfer_id,
        },
    );
    Ok(())
}

/// Create a remote directory (tech-gui.md §4.2); completion arrives as `sftp-op-done`.
#[tauri::command]
#[specta::specta]
pub fn sftp_mkdir(
    state: State<'_, GuiState>,
    session_id: u64,
    path: String,
) -> Result<(), CommandError> {
    state.send_sftp(session_id, SftpCommand::MkDir(path));
    Ok(())
}

/// Rename / move a remote path (tech-gui.md §4.2).
#[tauri::command]
#[specta::specta]
pub fn sftp_rename(
    state: State<'_, GuiState>,
    session_id: u64,
    from: String,
    to: String,
) -> Result<(), CommandError> {
    state.send_sftp(session_id, SftpCommand::Rename { from, to });
    Ok(())
}

/// Delete a remote file (falls back to an empty directory in the core) (tech-gui.md §4.2).
#[tauri::command]
#[specta::specta]
pub fn sftp_delete(
    state: State<'_, GuiState>,
    session_id: u64,
    path: String,
) -> Result<(), CommandError> {
    state.send_sftp(session_id, SftpCommand::Delete(path));
    Ok(())
}

/// Delete a remote file, or a directory with everything in it; completion arrives as
/// `sftp-op-done`. Symlinks are removed, never followed.
#[tauri::command]
#[specta::specta]
pub fn sftp_remove_tree(
    state: State<'_, GuiState>,
    session_id: u64,
    path: String,
) -> Result<(), CommandError> {
    state.send_sftp(session_id, SftpCommand::RemoveTree(path));
    Ok(())
}

/// Read a remote file's preview bytes (tech-gui.md §4.2); arrives as `file-preview`.
#[tauri::command]
#[specta::specta]
pub fn sftp_preview(
    state: State<'_, GuiState>,
    session_id: u64,
    path: String,
) -> Result<(), CommandError> {
    state.send_sftp(session_id, SftpCommand::ReadPreview(path));
    Ok(())
}

/// Close an SFTP session and its connection (tech-gui.md §4.2).
#[tauri::command]
#[specta::specta]
pub fn sftp_close(state: State<'_, GuiState>, session_id: u64) -> Result<(), CommandError> {
    state.close_sftp(session_id);
    Ok(())
}

/// List a local directory (tech-gui.md §4.2). Returns directly off the async worker;
/// the GUI never emits `LocalDirListed` (§4.3). The core prepends a `..` entry and
/// sorts dirs-first.
#[tauri::command]
#[specta::specta]
pub async fn list_local_dir(path: String) -> Result<Vec<FileEntryDto>, CommandError> {
    let entries = core_list_local_dir(&path).await.map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(entries.iter().map(FileEntryDto::from).collect())
}

/// Read up to 4 KiB of a local file as UTF-8 for preview (tech-gui.md §4.2).
#[tauri::command]
#[specta::specta]
pub async fn preview_local_file(path: String) -> Result<String, CommandError> {
    core_preview_local_file(&path)
        .await
        .map_err(|e| CommandError {
            message: e.to_string(),
        })
}

fn io_error(e: impl std::fmt::Display) -> CommandError {
    CommandError {
        message: e.to_string(),
    }
}

/// Create a local directory for the file manager's F7. Returns once it exists.
#[tauri::command]
#[specta::specta]
pub async fn local_mkdir(path: String) -> Result<(), CommandError> {
    tokio::fs::create_dir(&path).await.map_err(io_error)
}

/// Rename / move a local path (the file manager's Shift+F6). Fails rather than
/// replacing an existing destination, matching what SFTP's rename does.
#[tauri::command]
#[specta::specta]
pub async fn local_rename(from: String, to: String) -> Result<(), CommandError> {
    if tokio::fs::symlink_metadata(&to).await.is_ok() {
        return Err(io_error(format!("'{to}' already exists")));
    }
    tokio::fs::rename(&from, &to).await.map_err(io_error)
}

/// Delete a local file, or a directory with everything in it (the file manager's F8,
/// and the source side of a move). Symlinks are removed, never followed.
#[tauri::command]
#[specta::specta]
pub async fn local_delete(path: String) -> Result<(), CommandError> {
    remove_local_tree(&path)
        .await
        .map_err(|e| io_error(format!("{e:#}")))
}
