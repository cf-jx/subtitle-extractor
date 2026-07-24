use std::{ffi::OsString, path::Path, process::ExitStatus, sync::Arc, time::Duration};

use command_group::AsyncCommandGroup;
use parking_lot::Mutex;
use regex::Regex;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    sync::mpsc,
    time::{sleep, timeout},
};

use crate::state::{AppState, ManagedChild};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub struct ProcessOutput {
    pub stdout: String,
}

enum StreamEvent {
    Line { value: String, is_stderr: bool },
    Error(String),
    Closed,
}

pub async fn run_sidecar<F>(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    program: &str,
    args: Vec<OsString>,
    mut on_line: F,
) -> Result<ProcessOutput, String>
where
    F: FnMut(&str, bool) + Send,
{
    if state.is_cancelled(job_id) {
        return Err("任务已取消".into());
    }

    let command = app
        .shell()
        .sidecar(program)
        .map_err(|error| format!("无法启动 {program}：{error}"))?
        .args(args)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8");

    let std_command: std::process::Command = command.into();
    let mut command = tokio::process::Command::from(std_command);
    command.kill_on_drop(true);
    let mut group = command.group();
    group.kill_on_drop(true);
    let mut process = group
        .spawn()
        .map_err(|error| format!("启动 {program} 失败：{error}"))?;

    let stdout = match process.inner().stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = process.kill().await;
            return Err(format!("{program} 标准输出不可用"));
        }
    };
    let stderr = match process.inner().stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = process.kill().await;
            return Err(format!("{program} 错误输出不可用"));
        }
    };

    let child = Arc::new(Mutex::new(process));
    if let Err(error) = state.set_child(job_id, child.clone()) {
        let _ = reap_child(&child).await;
        return Err(error);
    }

    let (sender, mut receiver) = mpsc::unbounded_channel();
    let stdout_sender = sender.clone();
    tauri::async_runtime::spawn(read_stream(stdout, false, stdout_sender));
    tauri::async_runtime::spawn(read_stream(stderr, true, sender));

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_status = None;
    let mut readers_remaining = 2_usize;
    let mut process_error = None;

    while exit_status.is_none() || readers_remaining > 0 {
        if state.is_cancelled(job_id) {
            state.kill_child(job_id);
        }

        if exit_status.is_none() {
            match poll_child(&child) {
                Ok(status) => exit_status = status,
                Err(error) => {
                    process_error
                        .get_or_insert_with(|| format!("{program} 等待进程组结束失败：{error}"));
                    state.kill_child(job_id);
                }
            }
        }

        if exit_status.is_some() && readers_remaining == 0 {
            break;
        }

        if readers_remaining == 0 {
            sleep(PROCESS_POLL_INTERVAL).await;
            continue;
        }

        match timeout(PROCESS_POLL_INTERVAL, receiver.recv()).await {
            Ok(Some(StreamEvent::Line { value, is_stderr })) => {
                on_line(&value, is_stderr);
                if is_stderr {
                    append_bounded(&mut stderr, &value);
                } else {
                    append_bounded(&mut stdout, &value);
                }
            }
            Ok(Some(StreamEvent::Error(error))) => {
                process_error.get_or_insert_with(|| format!("{program} 读取进程输出失败：{error}"));
                state.kill_child(job_id);
            }
            Ok(Some(StreamEvent::Closed)) => {
                readers_remaining = readers_remaining.saturating_sub(1);
            }
            Ok(None) => {
                readers_remaining = 0;
            }
            Err(_) => {}
        }
    }
    state.clear_child(job_id);

    if state.is_cancelled(job_id) {
        return Err("任务已取消".into());
    }
    if let Some(error) = process_error {
        return Err(error);
    }
    let exit_code = exit_status.and_then(|status| status.code());
    if exit_code != Some(0) {
        let detail = last_nonempty_line(&stderr)
            .or_else(|| last_nonempty_line(&stdout))
            .unwrap_or("未知错误");
        return Err(format!("{program} 执行失败：{detail}"));
    }

    Ok(ProcessOutput { stdout })
}

fn poll_child(child: &ManagedChild) -> Result<Option<ExitStatus>, String> {
    child.lock().try_wait().map_err(|error| error.to_string())
}

async fn reap_child(child: &ManagedChild) -> Result<ExitStatus, String> {
    loop {
        if let Some(status) = poll_child(child)? {
            return Ok(status);
        }
        sleep(PROCESS_POLL_INTERVAL).await;
    }
}

async fn read_stream<R>(stream: R, is_stderr: bool, sender: mpsc::UnboundedSender<StreamEvent>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) => break,
            Ok(_) => {
                while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                    buffer.pop();
                }
                let value = String::from_utf8_lossy(&buffer).into_owned();
                if sender.send(StreamEvent::Line { value, is_stderr }).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(StreamEvent::Error(error.to_string()));
                break;
            }
        }
    }
    let _ = sender.send(StreamEvent::Closed);
}

pub async fn collect_sidecar(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    program: &str,
    args: Vec<OsString>,
) -> Result<ProcessOutput, String> {
    run_sidecar(app, state, job_id, program, args, |_, _| {}).await
}

fn append_bounded(target: &mut String, value: &str) {
    const MAX_CAPTURED_BYTES: usize = 64 * 1024;
    if target.len() >= MAX_CAPTURED_BYTES {
        return;
    }
    let remaining = MAX_CAPTURED_BYTES - target.len();
    if value.len() <= remaining {
        target.push_str(value);
        target.push('\n');
    }
}

fn last_nonempty_line(value: &str) -> Option<&str> {
    value.lines().rev().find(|line| !line.trim().is_empty())
}

pub fn parse_ytdlp_progress(line: &str) -> Option<f64> {
    let regex = Regex::new(r"download:\s*([0-9]+(?:\.[0-9]+)?)%").ok()?;
    regex
        .captures(line)?
        .get(1)?
        .as_str()
        .parse::<f64>()
        .ok()
        .map(|value| value.clamp(0.0, 100.0))
}

pub fn parse_ffmpeg_progress(line: &str, duration_seconds: f64) -> Option<f64> {
    if duration_seconds <= 0.0 {
        return None;
    }
    let value = line
        .trim()
        .strip_prefix("out_time_us=")?
        .parse::<f64>()
        .ok()?;
    Some(((value / 1_000_000.0) / duration_seconds * 100.0).clamp(0.0, 100.0))
}

pub fn first_media_file(directory: &Path) -> Result<std::path::PathBuf, String> {
    let mut files = std::fs::read_dir(directory)
        .map_err(|error| format!("无法读取下载目录：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("source."))
        })
        .collect::<Vec<_>>();
    files.sort();
    files
        .into_iter()
        .next()
        .ok_or_else(|| "链接解析成功，但没有下载到视频文件".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_progress() {
        assert_eq!(parse_ytdlp_progress("download: 45.7%"), Some(45.7));
        assert_eq!(
            parse_ffmpeg_progress("out_time_us=5000000", 10.0),
            Some(50.0)
        );
    }

    #[test]
    fn rejects_unknown_progress_lines() {
        assert_eq!(parse_ytdlp_progress("[download] unknown"), None);
        assert_eq!(parse_ffmpeg_progress("progress=continue", 10.0), None);
    }

    #[cfg(unix)]
    #[test]
    fn process_group_kill_terminates_descendants() {
        tauri::async_runtime::block_on(async {
            use std::process::Stdio;
            use tokio::io::AsyncBufReadExt;

            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .arg("-c")
                .arg("sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut group = command.group();
            group.kill_on_drop(true);
            let mut process = group.spawn().unwrap();
            let stdout = process.inner().stdout.take().unwrap();
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            timeout(Duration::from_secs(2), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            let descendant_pid = line.trim().parse::<u32>().unwrap();
            let child = Arc::new(Mutex::new(process));

            child.lock().start_kill().unwrap();
            let status = timeout(Duration::from_secs(5), reap_child(&child))
                .await
                .unwrap()
                .unwrap();
            assert!(!status.success());

            for _ in 0..100 {
                if !process_exists(descendant_pid) {
                    return;
                }
                sleep(Duration::from_millis(20)).await;
            }
            panic!("descendant process {descendant_pid} survived process-group kill");
        });
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("/bin/kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}
