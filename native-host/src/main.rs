//! Phoenix Shield — Chrome Native Messaging Host
//!
//! This binary implements the Chrome Native Messaging protocol:
//!   - Reads a 4-byte little-endian length prefix from stdin.
//!   - Reads exactly that many bytes of JSON.
//!   - Processes the message (logs it).
//!   - Optionally writes an acknowledgement back on stdout using the same
//!     length-prefixed protocol.
//!
//! On **Windows** the host also subscribes to ETW process-creation events
//! (Microsoft-Windows-Kernel-Process, Event ID 1).  When a clipboard copy
//! event arrives from the extension, the copied text is checked against the
//! command lines of all processes created in the last 5 minutes.  If a match
//! is found an **ALERT** is logged.  Every copy event is still printed for
//! sanity regardless of whether a match exists.
//!
//! IMPORTANT: stdout is reserved for the native-messaging protocol. All
//! debug/diagnostic output MUST go to stderr (via `eprintln!`) or to the
//! log file.

#[cfg(windows)]
mod process_monitor;

#[cfg(windows)]
use process_monitor::ProcessMonitor;

use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::PathBuf;

/// Incoming message from the Chrome extension.
#[derive(Debug, Deserialize, Serialize)]
struct ClipboardEvent {
    text: String,
    is_visible: bool,
    url: String,
    #[serde(default)]
    timestamp: Option<i64>,
}

/// Acknowledgement sent back to the extension.
#[derive(Debug, Serialize)]
struct Ack {
    status: String,
    received_at: String,
    /// Number of process command-line matches found (Windows only; always 0
    /// on other platforms).
    #[serde(skip_serializing_if = "Option::is_none")]
    matches: Option<usize>,
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/// Resolve the log file path.
///
/// - macOS/Linux: `~/phoenix-native-host.log`
/// - Windows:     `%USERPROFILE%\phoenix-native-host.log`
fn log_path() -> PathBuf {
    dirs_or_home().join("phoenix-native-host.log")
}

fn dirs_or_home() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(home);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Append a line to the log file.  Best-effort; errors go to stderr.
fn log_to_file(line: &str) {
    let path = log_path();
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
            let _ = writeln!(f, "[{timestamp}] {line}");
        }
        Err(e) => {
            eprintln!("Failed to open log file {}: {e}", path.display());
        }
    }
}

fn clipboard_queue_path() -> PathBuf {
    dirs_or_home().join("phoenix-clipboard-queue.jsonl")
}

fn write_clipboard_to_queue(event: &ClipboardEvent) {
    let path = clipboard_queue_path();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Utc::now().timestamp();
        let event_with_timestamp = serde_json::json!({
            "text": event.text,
            "is_visible": event.is_visible,
            "url": event.url,
            "timestamp": ts
        });
        if let Ok(json) = serde_json::to_string(&event_with_timestamp) {
            let _ = writeln!(f, "{}", json);
        }
    }
}

// ---------------------------------------------------------------------------
// Native Messaging Protocol helpers
// ---------------------------------------------------------------------------

/// Read one native-messaging frame from stdin.
///
/// Returns `None` on EOF (Chrome closed the pipe).
fn read_message(stdin: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let msg_len = u32::from_le_bytes(len_buf) as usize;

    // Chrome caps messages at 1 MB.
    if msg_len > 1_024 * 1_024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Message too large: {msg_len} bytes"),
        ));
    }

    let mut buf = vec![0u8; msg_len];
    stdin.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Write one native-messaging frame to stdout.
fn write_message(stdout: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = payload.len() as u32;
    stdout.write_all(&len.to_le_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

// ---------------------------------------------------------------------------
// ETW correlation (Windows-only helpers called from main loop)
// ---------------------------------------------------------------------------

/// Attempt to start the process monitor.  Returns `None` (with a
/// logged warning) if startup fails.
#[cfg(windows)]
fn try_start_monitor() -> Option<ProcessMonitor> {
    match ProcessMonitor::start() {
        Ok(monitor) => {
            log_to_file("[ProcessMonitor] Process creation monitor started successfully");
            Some(monitor)
        }
        Err(e) => {
            let msg = format!("[ProcessMonitor] Failed to start process monitor: {e}");
            eprintln!("{msg}");
            log_to_file(&msg);
            None
        }
    }
}

/// Check clipboard text against recent process command lines and log any
/// alerts.  Returns the number of matches found.
#[cfg(windows)]
fn correlate_with_processes(monitor: &ProcessMonitor, event: &ClipboardEvent) -> usize {
    let matches = monitor.find_matches(&event.text);
    if matches.is_empty() {
        return 0;
    }

    let header = format!(
        "ALERT  {} process command-line match(es) for clipboard text!",
        matches.len(),
    );
    eprintln!("\n!!! {header}");
    log_to_file(&format!("!!! {header}"));

    for (i, m) in matches.iter().enumerate() {
        let p = &m.process;
        let detail = format!(
            "  Match #{n}:\n\
             \x20   Copied text (first 120 chars): {preview:.120}\n\
             \x20   Process:       {img} (PID {pid})\n\
             \x20   Command line:  {cmd}\n\
             \x20   Process time:  {time}\n\
             \x20   Source URL:    {url}",
            n = i + 1,
            preview = event.text.replace('\n', "\\n"),
            img = p.image_name,
            pid = p.pid,
            cmd = p.command_line,
            time = p.wall_time.format("%Y-%m-%d %H:%M:%S"),
            url = event.url,
        );
        eprintln!("{detail}");
        log_to_file(&detail);
    }

    matches.len()
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

fn main() {
    log_to_file("=== Phoenix Native Host v1.0.1 started ===");

    // ---- Start process monitor (Windows only, polling-based, no admin needed) ----

    #[cfg(windows)]
    let process_monitor = try_start_monitor();

    // ---- Native messaging loop ----

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    loop {
        let raw = match read_message(&mut stdin) {
            Ok(Some(data)) => data,
            Ok(None) => {
                log_to_file("stdin closed (Chrome disconnected). Exiting.");
                break;
            }
            Err(e) => {
                log_to_file(&format!("Read error: {e}"));
                break;
            }
        };

        // Parse JSON.
        let event: ClipboardEvent = match serde_json::from_slice(&raw) {
            Ok(evt) => evt,
            Err(e) => {
                let lossy = String::from_utf8_lossy(&raw);
                log_to_file(&format!("JSON parse error: {e} | raw: {lossy}"));
                continue;
            }
        };

        // ---- Write clipboard event to queue for ETW monitor ----

        write_clipboard_to_queue(&event);

        // ---- Correlate against recent process command lines (Windows) ----

        #[cfg(windows)]
        let match_count = process_monitor
            .as_ref()
            .map(|m| correlate_with_processes(m, &event))
            .unwrap_or(0);

        #[cfg(not(windows))]
        let match_count: usize = 0;

        // ---- Send ACK back to Chrome ----

        let ack = Ack {
            status: "ok".to_string(),
            received_at: Local::now().to_rfc3339(),
            matches: if match_count > 0 {
                Some(match_count)
            } else {
                None
            },
        };
        let ack_json = serde_json::to_vec(&ack).expect("ack serialization");
        if let Err(e) = write_message(&mut stdout, &ack_json) {
            log_to_file(&format!("Write error: {e}"));
            break;
        }
    }

    log_to_file("=== Phoenix Native Host exiting ===");
}
