//! Windows-only process creation monitor using polling.
//!
//! Instead of ETW (which requires admin/Performance Log Users), we use
//! CreateToolhelp32Snapshot to poll for new processes every 500ms.  This
//! works without any special privileges.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};

pub const MIN_MATCH_LEN: usize = 8;
const RETENTION: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
pub struct ProcessCreation {
    pub instant: Instant,
    pub wall_time: DateTime<Local>,
    pub pid: u32,
    pub image_name: String,
    pub command_line: String,
}

#[derive(Debug)]
pub struct ProcessMatch {
    pub process: ProcessCreation,
}

pub struct ProcessMonitor {
    events: Arc<Mutex<Vec<ProcessCreation>>>,
    stop_flag: Arc<Mutex<bool>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl ProcessMonitor {
    pub fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let events: Arc<Mutex<Vec<ProcessCreation>>> =
            Arc::new(Mutex::new(Vec::with_capacity(256)));
        let stop_flag: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));

        let events_clone = Arc::clone(&events);
        let stop_clone = Arc::clone(&stop_flag);

        let handle = std::thread::spawn(move || {
            let mut seen_pids: HashMap<u32, u64> = HashMap::new();
            let mut snapshot_counter: u64 = 0;

            loop {
                if *stop_clone.lock().unwrap() {
                    break;
                }

                snapshot_counter = snapshot_counter.wrapping_add(1);
                let current_snapshot = snapshot_counter;

                // Use ToolHelp to enumerate processes
                let snapshot = unsafe {
                    windows::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot(
                        windows::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS,
                        0,
                    )
                };

                if let Ok(snapshot) = snapshot {
                    use windows::Win32::System::Diagnostics::ToolHelp::*;

                    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

                    if unsafe { Process32FirstW(snapshot, &mut entry).is_ok() } {
                        loop {
                            let pid = entry.th32ProcessID;
                            if pid != 0 {
                                let is_new = seen_pids
                                    .get(&pid)
                                    .map(|&snap| snap != current_snapshot)
                                    .unwrap_or(true);

                                if is_new {
                                    let cmd_line = get_process_command_line(pid);

                                    let creation = ProcessCreation {
                                        instant: Instant::now(),
                                        wall_time: Local::now(),
                                        pid,
                                        image_name: String::from_utf16_lossy(&entry.szExeFile)
                                            .trim_end_matches('\0')
                                            .to_string(),
                                        command_line: cmd_line,
                                    };

                                    if let Ok(mut vec) = events_clone.lock() {
                                        vec.push(creation);
                                    }

                                    seen_pids.insert(pid, current_snapshot);
                                }
                            }

                            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                                break;
                            }
                        }
                    }

                    unsafe { windows::Win32::Foundation::CloseHandle(snapshot) };
                }

                let cutoff = Instant::now() - RETENTION;
                if let Ok(mut vec) = events_clone.lock() {
                    vec.retain(|e| e.instant > cutoff);
                }

                std::thread::sleep(Duration::from_millis(500));
            }

        });

        Ok(Self {
            events,
            stop_flag,
            handle: Some(handle),
        })
    }

    pub fn find_matches(&self, text: &str) -> Vec<ProcessMatch> {
        let trimmed = text.trim();
        if trimmed.len() < MIN_MATCH_LEN {
            return Vec::new();
        }

        let needle = trimmed.to_lowercase();
        let cutoff = Instant::now() - RETENTION;

        let mut events = match self.events.lock() {
            Ok(guard) => guard,
            Err(_) => return Vec::new(),
        };

        events.retain(|e| e.instant > cutoff);

        let mut matches = Vec::new();
        for proc_event in events.iter() {
            let cmd_lower = proc_event.command_line.to_lowercase();
            if cmd_lower.contains(&needle) {
                matches.push(ProcessMatch {
                    process: proc_event.clone(),
                });
            }
        }

        matches
    }

    pub fn event_count(&self) -> usize {
        self.events.lock().map(|v| v.len()).unwrap_or(0)
    }
}

impl Drop for ProcessMonitor {
    fn drop(&mut self) {
        *self.stop_flag.lock().unwrap() = true;
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn get_process_command_line(pid: u32) -> String {
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Threading::*;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if let Ok(handle) = handle {
            let mut buffer: Vec<u16> = vec![0; 32768];
            let mut size = buffer.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let path = String::from_utf16_lossy(&buffer[..size as usize]);
                let _ = CloseHandle(handle);
                return path;
            }
            let _ = CloseHandle(handle);
        }
    }
    String::new()
}
