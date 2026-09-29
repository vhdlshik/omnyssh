//! Local terminal commands: list what can be opened, and open it. Everything after
//! the open — input, resize, close, the exit event — goes through the ordinary
//! terminal commands (see `crate::local`).

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

use crate::dto::{LocalShellDto, LocalTargetDto, LocalTargetsDto, TerminalBytes};
use crate::error::CommandError;
use crate::events;
use crate::local::{self, Shell};
use crate::state::GuiState;

fn error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

/// Detection can start a process (`wsl -l` on Windows), so it stays off the async
/// runtime's worker threads.
async fn shells() -> Result<Vec<Shell>, CommandError> {
    tauri::async_runtime::spawn_blocking(local::detect_shells)
        .await
        .map_err(|e| error(e.to_string()))
}

/// The shells and serial ports this machine has, for the local-terminal picker.
#[tauri::command]
#[specta::specta]
pub async fn local_targets() -> Result<LocalTargetsDto, CommandError> {
    let shells = shells().await?;
    let serial_ports = tauri::async_runtime::spawn_blocking(local::detect_serial_ports)
        .await
        .map_err(|e| error(e.to_string()))?;
    Ok(LocalTargetsDto {
        shells: shells.iter().map(LocalShellDto::from).collect(),
        serial_ports,
        baud_rates: local::BAUD_RATES.to_vec(),
    })
}

/// Open a local shell or serial port at `cols` x `rows`, streaming its output into
/// `on_output`. Returns the public id the terminal commands take.
#[tauri::command]
#[specta::specta]
pub async fn local_open(
    app: AppHandle,
    state: State<'_, GuiState>,
    target: LocalTargetDto,
    cols: u16,
    rows: u16,
    on_output: Channel<TerminalBytes>,
) -> Result<u64, CommandError> {
    // Reported once the session ends by itself; a tab closed first hears nothing.
    let on_exit = |public: u64| -> local::OnExit {
        let app = app.clone();
        Box::new(move || {
            if app.state::<GuiState>().local_exited(public) {
                let _ = events::TerminalExited { session_id: public }.emit(&app);
            }
        })
    };
    match target {
        LocalTargetDto::Shell { id } => {
            let shell = shells()
                .await?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| error(format!("'{id}' is not a shell on this machine")))?;
            state.open_local(|public| {
                local::spawn_shell(&shell, cols, rows, on_output, on_exit(public))
            })
        }
        LocalTargetDto::Serial { port, baud } => {
            state.open_local(|public| local::open_serial(&port, baud, on_output, on_exit(public)))
        }
    }
    .map_err(error)
}
