//! Local terminals: the machine's own shells, and serial consoles.
//!
//! Neither involves SSH or the core engine. A shell runs under the platform's
//! pseudo-terminal (a PTY on Unix, ConPTY on Windows) through `portable-pty`; a serial
//! port is opened with `serialport`. Both stream into the same per-tab channel an SSH
//! terminal uses and are addressed by an id from the same public id space, so the
//! frontend drives them with the ordinary `terminal_write` / `terminal_resize` /
//! `terminal_close` commands and learns of their end through `terminal-exited`.
//!
//! The frontend never names a program: it picks one of the shells this module detected,
//! by id, and the id is resolved again here at open time.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::dto::{LocalShellDto, SerialPortDto, TerminalBytes};

/// How long a serial read waits before checking whether the tab was closed.
const SERIAL_POLL: Duration = Duration::from_millis(100);

/// Serial speeds accepted from the frontend.
pub const BAUD_RATES: &[u32] = &[
    300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000,
    1500000, 2000000, 3000000,
];

/// A shell this machine can start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shell {
    /// Stable identifier the frontend hands back to open it.
    pub id: String,
    /// What the picker shows.
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl From<&Shell> for LocalShellDto {
    fn from(shell: &Shell) -> Self {
        LocalShellDto {
            id: shell.id.clone(),
            name: shell.name.clone(),
            detail: shell.program.display().to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Shell detection
// ---------------------------------------------------------------------------

/// The shells found on this machine, the default one first.
#[cfg(not(windows))]
pub fn detect_shells() -> Vec<Shell> {
    let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let login = std::env::var_os("SHELL").map(PathBuf::from);
    unix_shells(login.as_deref(), &listed, &|p| p.is_file())
}

/// `login` (from `$SHELL`) first, then each usable `/etc/shells` entry, skipping
/// duplicates (a symlinked `/bin` lists every shell twice) and non-interactive ones.
#[cfg_attr(windows, allow(dead_code))]
fn unix_shells(
    login: Option<&Path>,
    etc_shells: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<Shell> {
    let mut candidates: Vec<PathBuf> = login.map(Path::to_path_buf).into_iter().collect();
    candidates.extend(
        etc_shells
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('/'))
            .map(PathBuf::from),
    );
    if candidates.is_empty() {
        candidates.push(PathBuf::from("/bin/sh"));
    }

    let mut shells: Vec<Shell> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for path in candidates {
        let Some(base) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if matches!(base.as_str(), "nologin" | "false" | "true" | "git-shell") || !exists(&path) {
            continue;
        }
        let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        // `/bin/bash` and `/usr/bin/bash` are one shell; so are two names for one binary.
        if seen.contains(&canonical) || shells.iter().any(|s| s.name == base) {
            continue;
        }
        seen.push(canonical);
        // A login shell, as a terminal emulator starts one: profiles are read, so PATH
        // and the prompt match what the user gets anywhere else.
        let args = if is_known_unix_shell(&base) {
            vec!["-l".to_string()]
        } else {
            Vec::new()
        };
        shells.push(Shell {
            id: path.display().to_string(),
            name: base,
            program: path,
            args,
        });
    }
    shells
}

#[cfg_attr(windows, allow(dead_code))]
fn is_known_unix_shell(name: &str) -> bool {
    matches!(
        name,
        "sh" | "bash"
            | "rbash"
            | "dash"
            | "zsh"
            | "fish"
            | "ksh"
            | "mksh"
            | "pdksh"
            | "tcsh"
            | "csh"
            | "nu"
    )
}

/// The shells found on this machine: PowerShell 7, Windows PowerShell, Command
/// Prompt, Git Bash, then WSL and each of its distributions.
#[cfg(windows)]
pub fn detect_shells() -> Vec<Shell> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let system_root = env("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let system32 = system_root.join("System32");
    let mut shells = Vec::new();

    let pwsh = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|dir| dir.join("pwsh.exe"))
        .chain(env("ProgramFiles").map(|p| p.join(r"PowerShell\7\pwsh.exe")))
        .find(|p| p.is_file());
    if let Some(program) = pwsh {
        shells.push(Shell {
            id: "pwsh".into(),
            name: "PowerShell".into(),
            program,
            args: vec!["-NoLogo".into()],
        });
    }

    let powershell = system32.join(r"WindowsPowerShell\v1.0\powershell.exe");
    if powershell.is_file() {
        shells.push(Shell {
            id: "powershell".into(),
            name: "Windows PowerShell".into(),
            program: powershell,
            args: vec!["-NoLogo".into()],
        });
    }

    let cmd = env("ComSpec")
        .filter(|p| p.is_file())
        .unwrap_or_else(|| system32.join("cmd.exe"));
    if cmd.is_file() {
        shells.push(Shell {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            program: cmd,
            args: Vec::new(),
        });
    }

    let git_bash = [
        env("ProgramFiles").map(|p| p.join(r"Git\bin\bash.exe")),
        env("ProgramFiles(x86)").map(|p| p.join(r"Git\bin\bash.exe")),
        env("LOCALAPPDATA").map(|p| p.join(r"Programs\Git\bin\bash.exe")),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file());
    if let Some(program) = git_bash {
        shells.push(Shell {
            id: "gitbash".into(),
            name: "Git Bash".into(),
            program,
            args: vec!["--login".into(), "-i".into()],
        });
    }

    let wsl = system32.join("wsl.exe");
    if wsl.is_file() {
        let distros = wsl_distributions(&wsl);
        if !distros.is_empty() {
            shells.push(Shell {
                id: "wsl".into(),
                name: "WSL".into(),
                program: wsl.clone(),
                args: Vec::new(),
            });
        }
        for distro in distros {
            shells.push(Shell {
                id: format!("wsl:{distro}"),
                name: format!("WSL · {distro}"),
                program: wsl.clone(),
                args: vec!["-d".into(), distro],
            });
        }
    }
    shells
}

/// The installed WSL distributions. `wsl -l -q` answers in UTF-16; with WSL absent it
/// fails or lists nothing, and then no WSL entry is offered at all.
#[cfg(windows)]
fn wsl_distributions(wsl: &Path) -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = std::process::Command::new(wsl)
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_wsl_list(&out.stdout)
}

/// Distribution names from `wsl -l -q` output (UTF-16LE, one per line).
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_wsl_list(stdout: &[u8]) -> Vec<String> {
    let units: Vec<u16> = stdout
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

// ---------------------------------------------------------------------------
// Serial ports
// ---------------------------------------------------------------------------

/// The serial ports this machine has, with what the system knows about each.
pub fn detect_serial_ports() -> Vec<SerialPortDto> {
    // Without libudev the Linux scan panics when sysfs is not mounted (a container);
    // that is "no ports", not a crash.
    #[cfg(target_os = "linux")]
    if !Path::new("/sys/class/tty").is_dir() {
        return Vec::new();
    }
    let mut ports: Vec<SerialPortDto> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| SerialPortDto {
            detail: match p.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    let name = [usb.manufacturer, usb.product]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" ");
                    let ids = format!("{:04x}:{:04x}", usb.vid, usb.pid);
                    if name.is_empty() {
                        format!("USB {ids}")
                    } else {
                        format!("{name} ({ids})")
                    }
                }
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::Unknown => String::new(),
            },
            name: p.port_name,
        })
        .collect();
    ports.sort_by(|a, b| a.name.cmp(&b.name));
    ports.dedup_by(|a, b| a.name == b.name);
    ports
}

/// Whether `port` looks like a serial device path for this platform. Ports the scan
/// misses (a `/dev/ttyS*` without a driver entry, a symlink under `/dev/serial`) can
/// still be typed in, but nothing outside the device namespace can be opened this way.
pub fn plausible_serial_port(port: &str) -> bool {
    if port.is_empty() || port.contains('\0') || port.contains("..") {
        return false;
    }
    if cfg!(windows) {
        let bare = port.strip_prefix(r"\\.\").unwrap_or(port);
        bare.len() > 3
            && bare[..3].eq_ignore_ascii_case("COM")
            && bare[3..].chars().all(|c| c.is_ascii_digit())
    } else {
        port.starts_with("/dev/")
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

enum Backend {
    Pty {
        master: Mutex<Box<dyn MasterPty + Send>>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    },
    Serial {
        stop: Arc<AtomicBool>,
    },
}

/// A live local session: where keystrokes go, and how to end it.
pub struct LocalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    backend: Backend,
}

impl LocalSession {
    pub fn write(&self, data: &[u8]) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(data).and_then(|()| w.flush());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        // A serial line has no window size to report.
        if let Backend::Pty { master, .. } = &self.backend {
            if let Ok(master) = master.lock() {
                let _ = master.resize(size(cols, rows));
            }
        }
    }

    /// End the session. The reader thread notices on its own and exits.
    pub fn close(&self) {
        match &self.backend {
            Backend::Pty { killer, .. } => {
                if let Ok(mut killer) = killer.lock() {
                    let _ = killer.kill();
                }
            }
            Backend::Serial { stop } => stop.store(true, Ordering::Relaxed),
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Called once, from a background thread, when a session ends on its own.
pub type OnExit = Box<dyn FnOnce() + Send>;

/// Start `shell` in a pseudo-terminal of `cols` x `rows`, streaming its output into
/// `output`. `on_exit` runs when the shell exits.
pub fn spawn_shell(
    shell: &Shell,
    cols: u16,
    rows: u16,
    output: Channel<TerminalBytes>,
    on_exit: OnExit,
) -> Result<LocalSession, String> {
    let pair = portable_pty::native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| format!("could not create a terminal: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell.program);
    cmd.args(&shell.args);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "OmnySSH");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {}: {e}", shell.name))?;
    // The child holds its own end now; keeping ours open would stop the reader from
    // ever seeing end-of-file on Unix.
    drop(pair.slave);

    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to the terminal: {e}"))?;

    spawn_reader(reader, output, None);
    // The exit is taken from the child, not from end-of-file: ConPTY keeps the output
    // pipe open after the shell is gone, until the pseudo-console itself is closed.
    std::thread::Builder::new()
        .name("local-shell-wait".into())
        .spawn(move || {
            let _ = child.wait();
            on_exit();
        })
        .map_err(|e| e.to_string())?;

    Ok(LocalSession {
        writer: Mutex::new(writer),
        backend: Backend::Pty {
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
        },
    })
}

/// Open serial `port` at `baud` (8 data bits, no parity, 1 stop bit, no flow control),
/// streaming what arrives into `output`. `on_exit` runs if the device goes away.
pub fn open_serial(
    port: &str,
    baud: u32,
    output: Channel<TerminalBytes>,
    on_exit: OnExit,
) -> Result<LocalSession, String> {
    if !BAUD_RATES.contains(&baud) {
        return Err(format!("unsupported speed {baud}"));
    }
    if !plausible_serial_port(port) {
        return Err(format!("'{port}' is not a serial port"));
    }
    let device = serialport::new(port, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(SERIAL_POLL)
        .open()
        .map_err(|e| format!("could not open {port}: {e}"))?;
    let writer = device
        .try_clone()
        .map_err(|e| format!("could not open {port} for writing: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    spawn_reader(
        Box::new(SerialReader(device)),
        output,
        Some((Arc::clone(&stop), on_exit)),
    );
    Ok(LocalSession {
        writer: Mutex::new(Box::new(writer)),
        backend: Backend::Serial { stop },
    })
}

/// A serial port as a plain reader: a read timeout is "nothing yet", not an error.
struct SerialReader(Box<dyn serialport::SerialPort>);

impl Read for SerialReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.0.read(buf) {
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "no data yet",
            )),
            other => other,
        }
    }
}

/// Pump `reader` into `output` until end-of-file or an error. With `serial` set, the
/// flag ends the loop early (the tab was closed) and the callback reports a device
/// that went away on its own.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    output: Channel<TerminalBytes>,
    serial: Option<(Arc<AtomicBool>, OnExit)>,
) {
    let _ = std::thread::Builder::new()
        .name("local-terminal-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            let stop = serial.as_ref().map(|(s, _)| Arc::clone(s));
            loop {
                if stop.as_ref().is_some_and(|s| s.load(Ordering::Relaxed)) {
                    return; // closed from the tab: nothing to report
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output.send(TerminalBytes(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if let Some((stop, on_exit)) = serial {
                if !stop.load(Ordering::Relaxed) {
                    on_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_shell_comes_first_and_duplicates_are_dropped() {
        let etc = "# comment\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n/usr/sbin/nologin\n/bin/false\n";
        let exists = |p: &Path| p.to_str() != Some("/usr/bin/zsh");
        let shells = unix_shells(Some(Path::new("/bin/bash")), etc, &exists);
        let names: Vec<_> = shells.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["bash", "sh"]);
        assert_eq!(shells[0].id, "/bin/bash");
        assert_eq!(shells[0].args, ["-l"]);
    }

    #[test]
    fn an_empty_shell_list_still_offers_sh() {
        let shells = unix_shells(None, "", &|p| p == Path::new("/bin/sh"));
        assert_eq!(shells.len(), 1);
        assert_eq!(shells[0].name, "sh");
    }

    #[test]
    fn unknown_shells_start_without_a_login_flag() {
        let shells = unix_shells(None, "/opt/xonsh\n", &|_| true);
        assert!(shells[0].args.is_empty());
    }

    #[test]
    fn wsl_distributions_are_read_from_utf16() {
        let text = "\u{feff}Ubuntu-22.04\r\ndocker-desktop\r\n\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu-22.04", "docker-desktop"]);
        assert!(parse_wsl_list(&[]).is_empty());
    }

    #[test]
    fn only_device_paths_are_opened_as_serial_ports() {
        if cfg!(windows) {
            assert!(plausible_serial_port("COM3"));
            assert!(plausible_serial_port(r"\\.\COM12"));
            assert!(!plausible_serial_port("C:\\secret.txt"));
        } else {
            assert!(plausible_serial_port("/dev/ttyUSB0"));
            assert!(plausible_serial_port("/dev/serial/by-id/usb-FTDI"));
            assert!(!plausible_serial_port("/etc/passwd"));
            assert!(!plausible_serial_port("/dev/../etc/passwd"));
        }
        assert!(!plausible_serial_port(""));
    }

    /// Needs a serial device, so it only runs on request, e.g. with a virtual cable:
    /// `socat pty,raw,echo=0,link=/tmp/omny-a pty,raw,echo=0,link=/tmp/omny-b`, then
    /// `OMNY_SERIAL_A=/tmp/omny-a OMNY_SERIAL_B=/tmp/omny-b cargo test -- --ignored serial`.
    #[test]
    #[ignore]
    fn a_serial_port_carries_bytes_both_ways() {
        let (Ok(a), Ok(b)) = (
            std::env::var("OMNY_SERIAL_A"),
            std::env::var("OMNY_SERIAL_B"),
        ) else {
            panic!("set OMNY_SERIAL_A and OMNY_SERIAL_B to the two ends of a serial link");
        };
        // `plausible_serial_port` wants a device path; resolve the socat links to /dev/pts/N.
        let a = std::fs::canonicalize(a).unwrap().display().to_string();
        let b = std::fs::canonicalize(b).unwrap().display().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let output = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                let _ = tx.send(bytes);
            }
            Ok(())
        });
        let session = open_serial(&a, 115200, output, Box::new(|| {})).expect("open");
        let mut far = serialport::new(&b, 115200)
            .timeout(Duration::from_secs(2))
            .open()
            .expect("far end");

        far.write_all(b"hello from the device\r\n").unwrap();
        let got = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("device output");
        assert!(String::from_utf8_lossy(&got).contains("hello"));

        session.write(b"AT\r");
        let mut buf = [0u8; 16];
        let n = far.read(&mut buf).expect("keystrokes reach the device");
        assert_eq!(&buf[..n], b"AT\r");
        session.close();
    }

    #[test]
    fn a_shell_runs_and_its_exit_is_reported() {
        let Some(shell) = detect_shells().into_iter().next() else {
            return; // no shell on this machine
        };
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let output = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                let _ = tx.send(bytes);
            }
            Ok(())
        });
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let session = spawn_shell(
            &shell,
            80,
            24,
            output,
            Box::new(move || {
                let _ = done_tx.send(());
            }),
        )
        .expect("spawn");
        let exit = if cfg!(windows) {
            "echo omny-%OS%\r\nexit\r\n"
        } else {
            "echo omny-$((6*7))\nexit\n"
        };
        session.write(exit.as_bytes());
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the shell's exit was reported");
        let mut seen = Vec::new();
        while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
            seen.extend(chunk);
        }
        let text = String::from_utf8_lossy(&seen);
        assert!(
            text.contains(if cfg!(windows) {
                "omny-Windows_NT"
            } else {
                "omny-42"
            }),
            "{text}"
        );
        session.close();
    }
}
