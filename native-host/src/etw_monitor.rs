//! Phoenix ETW Monitor — Real-time ETW process monitoring using ferrisetw
//!
//! Uses ferrisetw to subscribe to Microsoft-Windows-Kernel-Process events.
//! Receives full command lines from ETW Event ID 1 (ProcessStart).
//! Requires Administrator privileges.
//!
//! Provider: Microsoft-Windows-Kernel-Process
//! GUID: 22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716

use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use ferrisetw::parser::Parser;
#[cfg(windows)]
use ferrisetw::provider::Provider;
#[cfg(windows)]
use ferrisetw::schema_locator::SchemaLocator;
#[cfg(windows)]
use ferrisetw::trace::{TraceTrait, UserTrace};
#[cfg(windows)]
use ferrisetw::EventRecord;

const SESSION_NAME: &str = "PhoenixETWMonitor";
const MIN_MATCH_LEN: usize = 8;
const RETENTION_SECS: i64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessEvent {
    pub pid: u32,
    pub ppid: u32,
    pub image_name: String,
    pub command_line: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardEvent {
    pub text: String,
    pub url: String,
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub is_visible: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub process: ProcessEvent,
    pub clipboard_text: String,
    pub source_url: String,
    pub timestamp: i64,
}

fn log_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("phoenix-etw-monitor.log")
}

fn queue_file_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("phoenix-clipboard-queue.jsonl")
}

fn log_to_file(line: &str) {
    let path = log_path();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{timestamp}] {line}");
    }
}

struct Tracker {
    clipboards: VecDeque<ClipboardEvent>,
    /// PIDs for which an alert has already been fired this session.
    /// Prevents duplicate alerts when ETW re-delivers the same process event.
    alerted_pids: HashSet<u32>,
}

impl Tracker {
    fn new() -> Self {
        Self {
            clipboards: VecDeque::with_capacity(64),
            alerted_pids: HashSet::new(),
        }
    }

    fn gc(&mut self) {
        let cutoff = Utc::now().timestamp() - RETENTION_SECS;
        while self
            .clipboards
            .front()
            .map(|e| e.timestamp.unwrap_or(0) < cutoff)
            .unwrap_or(false)
        {
            self.clipboards.pop_front();
        }
    }

    /// Called when a new process is detected via ETW.
    /// Checks it against all recent clipboard events (last 5 min).
    /// Returns at most one alert per PID — ETW can re-deliver the same event.
    fn check_process(&mut self, event: &ProcessEvent) -> Vec<Alert> {
        self.gc();

        if self.alerted_pids.contains(&event.pid) {
            return Vec::new();
        }

        let mut alerts = Vec::new();
        for clip in &self.clipboards {
            if args_match(&clip.text, &event.command_line, &event.image_name) {
                alerts.push(Alert {
                    process: event.clone(),
                    clipboard_text: clip.text.clone(),
                    source_url: clip.url.clone(),
                    timestamp: Utc::now().timestamp(),
                });
                // One alert per PID is enough — stop after the first match.
                self.alerted_pids.insert(event.pid);
                break;
            }
        }
        alerts
    }

    /// Called when a new clipboard event arrives.
    /// Just stores it for future process checks.
    fn add_clipboard(&mut self, event: ClipboardEvent) {
        self.clipboards.push_back(event);
        self.gc();
    }
}

/// Match clipboard text against a process command line using the exe name
/// from ETW as the anchor point.
///
/// Example:
///   clipboard:  "powershell -w h -c ..."
///   cmd_line:   "C:\...\PowerShell.exe" -w h -c ...
///   image_name: \Device\...\powershell.exe
///
/// 1. Extract exe stem from image_name: "powershell"
/// 2. Find "powershell" in clipboard, take args after it
/// 3. Find "powershell" in cmd_line, take args after it (skip .exe, quotes)
/// 4. Compare the args
fn args_match(clipboard: &str, cmd_line: &str, image_name: &str) -> bool {
    let clipboard = clipboard.trim();
    if clipboard.len() < MIN_MATCH_LEN || cmd_line.is_empty() {
        return false;
    }

    let clip_lower = clipboard.to_lowercase();
    let cmd_lower = cmd_line.to_lowercase();

    // Extract exe stem: \Device\...\powershell.exe -> powershell
    let exe_name = image_name
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_lowercase()
        .replace(".exe", "");

    if exe_name.is_empty() {
        return false;
    }

    // Find exe name in clipboard text (first occurrence)
    let needle_pos = match clip_lower.find(&exe_name) {
        Some(p) => p,
        None => return false,
    };

    // Find exe name in command line — use LAST occurrence to avoid matching
    // inside path components like "windowspowershell"
    let cmd_pos = match cmd_lower.rfind(&exe_name) {
        Some(p) => p,
        None => return false,
    };

    // Get args after exe name in clipboard
    let needle_args = clip_lower[needle_pos + exe_name.len()..]
        .trim_start_matches(".exe")
        .trim_start_matches('"')
        .trim();

    // Get args after exe name in command line
    let cmd_args = cmd_lower[cmd_pos + exe_name.len()..]
        .trim_start_matches(".exe")
        .trim_start_matches('"')
        .trim();

    if needle_args.len() < MIN_MATCH_LEN || cmd_args.is_empty() {
        return false;
    }

    cmd_args.starts_with(needle_args) || needle_args.starts_with(cmd_args)
}

// ---------------------------------------------------------------------------
// Get command line from a live process via WMI
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn get_process_cmdline_wmi(pid: u32) -> String {
    use ntapi::ntpsapi::NtQueryInformationProcess;
    use ntapi::ntpsapi::ProcessBasicInformation;
    use ntapi::ntpsapi::PROCESS_BASIC_INFORMATION;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::memoryapi::ReadProcessMemory;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::{PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return String::new();
        }

        // Get PEB address via NtQueryInformationProcess
        let mut pbi: PROCESS_BASIC_INFORMATION = std::mem::zeroed();
        let mut return_length: u32 = 0;
        let status = NtQueryInformationProcess(
            handle,
            ProcessBasicInformation,
            &mut pbi as *mut _ as *mut _,
            std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut return_length,
        );

        if status < 0 || pbi.PebBaseAddress.is_null() {
            CloseHandle(handle);
            return String::new();
        }

        // Read ProcessParameters pointer from PEB
        // PEB.ProcessParameters is at offset 0x20 on 64-bit
        let params_offset = 0x20usize;
        let mut process_parameters_ptr: usize = 0;
        let mut bytes_read: usize = 0;

        let ok = ReadProcessMemory(
            handle,
            (pbi.PebBaseAddress as usize + params_offset) as *const _,
            &mut process_parameters_ptr as *mut _ as *mut _,
            std::mem::size_of::<usize>(),
            &mut bytes_read,
        );

        if ok == 0 || process_parameters_ptr == 0 {
            CloseHandle(handle);
            return String::new();
        }

        // Read UNICODE_STRING for CommandLine from RTL_USER_PROCESS_PARAMETERS
        // CommandLine is at offset 0x70 on 64-bit
        let cmdline_offset = 0x70usize;
        let mut cmd_unicode: [u8; 16] = [0; 16]; // UNICODE_STRING is 16 bytes on 64-bit

        let ok = ReadProcessMemory(
            handle,
            (process_parameters_ptr + cmdline_offset) as *const _,
            cmd_unicode.as_mut_ptr() as *mut _,
            16,
            &mut bytes_read,
        );

        if ok == 0 {
            CloseHandle(handle);
            return String::new();
        }

        // Parse UNICODE_STRING: Length (u16), MaxLength (u16), padding (u32), Buffer (u64)
        let length = u16::from_le_bytes([cmd_unicode[0], cmd_unicode[1]]) as usize;
        let buffer_ptr = u64::from_le_bytes([
            cmd_unicode[8],
            cmd_unicode[9],
            cmd_unicode[10],
            cmd_unicode[11],
            cmd_unicode[12],
            cmd_unicode[13],
            cmd_unicode[14],
            cmd_unicode[15],
        ]) as usize;

        if length == 0 || buffer_ptr == 0 || length > 65534 {
            CloseHandle(handle);
            return String::new();
        }

        // Read the actual command line string
        let mut cmd_buf: Vec<u8> = vec![0; length];
        let ok = ReadProcessMemory(
            handle,
            buffer_ptr as *const _,
            cmd_buf.as_mut_ptr() as *mut _,
            length,
            &mut bytes_read,
        );

        CloseHandle(handle);

        if ok == 0 || bytes_read == 0 {
            return String::new();
        }

        // Convert UTF-16LE to String
        let wide: Vec<u16> = cmd_buf[..bytes_read]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();

        String::from_utf16_lossy(&wide)
            .trim_end_matches('\0')
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// ETW via ferrisetw
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn start_etw(
    processes: Arc<Mutex<Tracker>>,
) -> Result<ferrisetw::trace::UserTrace, ferrisetw::trace::TraceError> {
    let procs = processes.clone();

    let process_callback = move |record: &EventRecord, schema_locator: &SchemaLocator| {
        match schema_locator.event_schema(record) {
            Err(_) => {}
            Ok(schema) => {
                if record.event_id() == 1 {
                    let parser = Parser::create(record, &schema);

                    let pid: u32 = parser.try_parse("ProcessID").unwrap_or(0);
                    let image_name: String = parser.try_parse("ImageName").unwrap_or_default();
                    let ppid: u32 = parser.try_parse("ParentProcessID").unwrap_or(0);

                    if pid == 0 {
                        return;
                    }

                    // ETW Kernel-Process doesn't give CommandLine in Event ID 1.
                    // Read it from the live process via WMI/powershell.
                    let command_line = get_process_cmdline_wmi(pid);

                    let event = ProcessEvent {
                        pid,
                        ppid,
                        image_name: image_name.clone(),
                        command_line: command_line.clone(),
                        timestamp: Utc::now().timestamp(),
                    };

                    if let Ok(mut tracker) = procs.lock() {
                        let alerts = tracker.check_process(&event);
                        for alert in &alerts {
                            let alert_msg = format!(
                                "!!! ALERT: Clipboard text matches new process !!!\n\
                                 \x20  Process: {} (PID {})\n\
                                 \x20  Command: {}\n\
                                 \x20  Clipboard: {}\n\
                                 \x20  Source URL: {}",
                                alert.process.image_name,
                                alert.process.pid,
                                alert.process.command_line,
                                alert.clipboard_text,
                                alert.source_url
                            );
                            eprintln!("\n{}", alert_msg);
                            log_to_file(&alert_msg);
                            show_alert_notification(&alert.process.image_name, alert.process.pid);
                        }
                    }
                }
            }
        }
    };

    // Microsoft-Windows-Kernel-Process provider
    let process_provider = Provider::by_guid("22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716")
        .add_callback(process_callback)
        .build();

    let trace = UserTrace::new()
        .named(String::from(SESSION_NAME))
        .enable(process_provider)
        .start_and_process()?;

    Ok(trace)
}

// ---------------------------------------------------------------------------
// Clipboard queue reader
// ---------------------------------------------------------------------------

fn read_clipboard_queue(processes: Arc<Mutex<Tracker>>, running: Arc<AtomicBool>) {
    let queue_path = queue_file_path();
    let mut last_pos: u64 = 0;

    while running.load(Ordering::SeqCst) {
        if let Ok(mut file) = File::open(&queue_path) {
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            if size > last_pos {
                if file.seek(SeekFrom::Start(last_pos)).is_ok() {
                    let mut new_content = String::new();
                    if file.read_to_string(&mut new_content).is_ok() {
                        for line in new_content.lines() {
                            if let Ok(event) = serde_json::from_str::<ClipboardEvent>(line) {
                                if let Ok(mut tracker) = processes.lock() {
                                    tracker.add_clipboard(event);
                                }
                            }
                        }
                        last_pos = size;
                    }
                }
            }
        }

        thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(windows)]
fn show_alert_notification(process_name: &str, pid: u32) {
    use std::process::Command;

    let msg = format!("Process match: {} (PID {})", process_name, pid);

    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $n = New-Object System.Windows.Forms.NotifyIcon; \
         $n.Icon = [System.Drawing.SystemIcons]::Warning; \
         $n.Visible = $true; \
         $n.ShowBalloonTip(5000, 'Phoenix Security Alert', '{}', 'Warning'); \
         Start-Sleep 6; $n.Dispose()",
        msg.replace("'", "''")
    );

    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .spawn();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let running = Arc::new(AtomicBool::new(true));
    let processes = Arc::new(Mutex::new(Tracker::new()));

    // Ctrl+C handler — signal the loop to exit
    let running_ctrlc = Arc::clone(&running);
    ctrlc::set_handler(move || {
        running_ctrlc.store(false, Ordering::SeqCst);
    })
    .expect("Error setting Ctrl+C handler");

    // Start ETW trace
    #[cfg(windows)]
    let _trace = start_etw(Arc::clone(&processes)).ok();

    // Start clipboard queue reader
    let procs_clone = Arc::clone(&processes);
    let run_clone = Arc::clone(&running);
    thread::spawn(move || {
        read_clipboard_queue(procs_clone, run_clone);
    });

    // Keep main thread alive until Ctrl+C
    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(500));
    }

    // Clean up ETW session so it doesn't linger in the kernel
    #[cfg(windows)]
    if let Some(mut trace) = _trace {
        let _ = trace.stop();
    }
}
