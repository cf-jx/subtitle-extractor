use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::{
    domain::{
        AppInfo, ExportTranscriptRequest, JobSnapshot, JobStage, SourceKind, StartJobRequest,
    },
    douyin,
    state::AppState,
    subtitles,
    tools::{
        collect_sidecar, first_media_file, parse_ffmpeg_progress, parse_ytdlp_progress, run_sidecar,
    },
    transcription,
    validation::{
        safe_output_stem, sanitize_stem, validate_local_file, validate_output_dir,
        validate_video_url,
    },
};

const MODEL_FILE_NAME: &str = "ggml-small-q5_1.bin";
const OWNERSHIP_MARKER: &str = ".owned-by-subtitle-extractor";

#[derive(Debug, Deserialize)]
struct ProbeOutput {
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[tauri::command]
pub async fn get_app_info(app: AppHandle) -> Result<AppInfo, String> {
    let path = model_path(&app)?;
    let model_ready =
        tauri::async_runtime::spawn_blocking(move || transcription::verify_model(&path).is_ok())
            .await
            .map_err(|error| format!("检查字幕模型任务失败：{error}"))?;

    Ok(AppInfo {
        platform: std::env::consts::OS,
        model_name: "Whisper Small",
        model_ready,
    })
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> Vec<JobSnapshot> {
    state.list_jobs()
}

#[tauri::command]
pub async fn start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartJobRequest,
) -> Result<JobSnapshot, String> {
    let state = state.inner().clone();
    let output_dir = validate_output_dir(&request.output_dir)?;
    let job_id = Uuid::new_v4().to_string();

    let (source, display_name) = match request.source_kind {
        SourceKind::Local => {
            let source = validate_local_file(&request.source)?;
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("本地视频")
                .to_string();
            (path_string(&source)?, name)
        }
        SourceKind::Url => {
            let url = validate_video_url(&request.source)?;
            let platform = if url
                .host_str()
                .is_some_and(|host| host.ends_with("douyin.com"))
            {
                "抖音视频"
            } else {
                "TikTok视频"
            };
            (url.to_string(), format!("{platform}-{}", &job_id[..8]))
        }
    };

    let normalized_request = StartJobRequest {
        source_kind: request.source_kind,
        source: source.clone(),
        output_dir: path_string(&output_dir)?,
    };
    let output_stem = safe_output_stem(Path::new(&display_name));
    let lock_root = output_reservation_root(&app)?;
    let reservation = subtitles::reserve_exports(&lock_root, &output_dir, &output_stem)?;
    let snapshot = JobSnapshot {
        id: job_id.clone(),
        source_kind: request.source_kind,
        source,
        display_name,
        output_dir: normalized_request.output_dir.clone(),
        stage: JobStage::Queued,
        stage_progress: None,
        overall_progress: Some(0.0),
        message: "等待处理".into(),
        created_at: Utc::now().to_rfc3339(),
        segments: Vec::new(),
        outputs: None,
        error: None,
    };

    state.insert_job(snapshot.clone());
    emit(&app, &snapshot);

    tauri::async_runtime::spawn(run_queued_job(
        app,
        state,
        job_id,
        normalized_request,
        reservation,
    ));
    Ok(snapshot)
}

#[tauri::command]
pub fn cancel_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<JobSnapshot, String> {
    let state = state.inner();
    let existing = state
        .get_job(&job_id)
        .ok_or_else(|| "找不到任务".to_string())?;
    if existing.stage.is_terminal() {
        return Ok(existing);
    }

    state.cancel(&job_id)?;
    let snapshot = state
        .update_job(&job_id, |job| {
            job.stage = JobStage::Cancelled;
            job.stage_progress = None;
            job.message = "任务已取消".into();
            job.error = None;
        })
        .ok_or_else(|| "找不到任务".to_string())?;
    emit(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn export_transcript(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExportTranscriptRequest,
) -> Result<JobSnapshot, String> {
    let state = state.inner().clone();
    let existing = state
        .get_job(&request.job_id)
        .ok_or_else(|| "找不到任务".to_string())?;
    if existing.stage != JobStage::Completed {
        return Err("任务完成后才能导出字幕".into());
    }
    let output_dir = validate_output_dir(&existing.output_dir)?;
    let stem = format!(
        "{}-编辑",
        sanitize_stem(
            Path::new(&existing.display_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&existing.display_name)
        )
    );
    subtitles::ensure_exports_available(&output_dir, &stem)?;
    let segments = request.segments;
    let output_dir_for_task = output_dir.clone();
    let outputs = tauri::async_runtime::spawn_blocking(move || {
        subtitles::write_exports(&output_dir_for_task, &stem, segments)
    })
    .await
    .map_err(|error| format!("导出字幕任务失败：{error}"))??;

    let snapshot = state
        .replace_job(&request.job_id, |job| {
            job.outputs = Some(outputs);
            job.message = "字幕已导出".into();
        })
        .ok_or_else(|| "找不到任务".to_string())?;
    emit(&app, &snapshot);
    Ok(snapshot)
}

async fn run_queued_job(
    app: AppHandle,
    state: AppState,
    job_id: String,
    request: StartJobRequest,
    reservation: subtitles::OutputReservation,
) {
    let cancellation = match state.cancellation_notifier(&job_id) {
        Some(cancellation) => cancellation,
        None => {
            finish_failed(&app, &state, &job_id, "找不到任务控制状态".into());
            return;
        }
    };
    let queue = state.queue();
    let permit = tokio::select! {
        permit = queue.acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => {
                finish_failed(&app, &state, &job_id, "任务队列不可用".into());
                return;
            }
        },
        _ = cancellation.notified() => {
            state.finish_control(&job_id);
            return;
        }
    };

    if state.is_cancelled(&job_id) {
        drop(permit);
        state.finish_control(&job_id);
        return;
    }

    let root = match job_cache_root(&app) {
        Ok(root) => root,
        Err(error) => {
            finish_failed(&app, &state, &job_id, error);
            drop(permit);
            state.finish_control(&job_id);
            return;
        }
    };
    let job_dir = root.join(format!("job-{job_id}"));
    let result = match create_owned_job_dir(&job_dir) {
        Ok(()) => execute_pipeline(&app, &state, &job_id, &request, &job_dir).await,
        Err(error) => Err(error),
    };

    let cleanup_result = cleanup_owned_job_dir(&root, &job_dir);
    if let Err(error) = cleanup_result {
        log::warn!(
            "Failed to clean job directory {}: {error}",
            job_dir.display()
        );
    }

    match result {
        Ok(()) => {}
        Err(error) if state.is_cancelled(&job_id) || error == "任务已取消" => {
            if let Some(snapshot) = state.replace_job(&job_id, |job| {
                job.stage = JobStage::Cancelled;
                job.stage_progress = None;
                job.message = "任务已取消".into();
                job.error = None;
            }) {
                emit(&app, &snapshot);
            }
        }
        Err(error) => finish_failed(&app, &state, &job_id, error),
    }

    drop(permit);
    state.finish_control(&job_id);
    drop(reservation);
}

async fn execute_pipeline(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    request: &StartJobRequest,
    job_dir: &Path,
) -> Result<(), String> {
    let source_path = match request.source_kind {
        SourceKind::Local => PathBuf::from(&request.source),
        SourceKind::Url => download_video(app, state, job_id, &request.source, job_dir).await?,
    };
    ensure_not_cancelled(state, job_id)?;

    update_stage(
        app,
        state,
        job_id,
        JobStage::ProbingMedia,
        None,
        Some(if request.source_kind == SourceKind::Url {
            25.0
        } else {
            2.0
        }),
        "正在检查视频音轨",
    );
    let duration = probe_duration(app, state, job_id, &source_path).await?;

    let wav_path = job_dir.join("audio.wav");
    extract_audio(app, state, job_id, &source_path, &wav_path, duration).await?;
    ensure_not_cancelled(state, job_id)?;

    update_stage(
        app,
        state,
        job_id,
        JobStage::LoadingModel,
        None,
        Some(38.0),
        "正在加载本地字幕模型",
    );
    let model = if let Some(model) = state.model() {
        model
    } else {
        let path = model_path(app)?;
        let model = tauri::async_runtime::spawn_blocking(move || transcription::load_model(&path))
            .await
            .map_err(|error| format!("加载字幕模型任务失败：{error}"))??;
        state.set_model(model.clone());
        model
    };
    ensure_not_cancelled(state, job_id)?;

    update_stage(
        app,
        state,
        job_id,
        JobStage::Transcribing,
        Some(0.0),
        Some(40.0),
        "正在识别字幕",
    );
    let transcription_app = app.clone();
    let transcription_state = state.clone();
    let transcription_job_id = job_id.to_string();
    let segments = tauri::async_runtime::spawn_blocking(move || {
        transcription::transcribe_wav(
            transcription_app,
            transcription_state,
            transcription_job_id,
            model,
            wav_path,
        )
    })
    .await
    .map_err(|error| format!("字幕识别任务失败：{error}"))??;
    ensure_not_cancelled(state, job_id)?;

    update_stage(
        app,
        state,
        job_id,
        JobStage::Exporting,
        Some(0.0),
        Some(95.0),
        "正在生成字幕文件",
    );
    let output_dir = PathBuf::from(&request.output_dir);
    let display_name = state
        .get_job(job_id)
        .map(|job| job.display_name)
        .unwrap_or_else(|| "字幕".into());
    let output_stem = safe_output_stem(Path::new(&display_name));
    let export_segments = segments.clone();
    let outputs = tauri::async_runtime::spawn_blocking(move || {
        subtitles::write_exports(&output_dir, &output_stem, export_segments)
    })
    .await
    .map_err(|error| format!("生成字幕文件任务失败：{error}"))??;
    if let Err(error) = ensure_not_cancelled(state, job_id) {
        subtitles::remove_exports(&outputs);
        return Err(error);
    }

    let snapshot = state
        .update_job(job_id, |job| {
            job.stage = JobStage::Completed;
            job.stage_progress = Some(100.0);
            job.overall_progress = Some(100.0);
            job.message = "字幕提取完成".into();
            job.segments = segments;
            job.outputs = Some(outputs.clone());
            job.error = None;
        })
        .ok_or_else(|| "找不到任务".to_string())?;
    if snapshot.stage != JobStage::Completed {
        subtitles::remove_exports(&outputs);
        return Err("任务已取消".into());
    }
    emit(app, &snapshot);
    Ok(())
}

async fn download_video(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    url: &str,
    job_dir: &Path,
) -> Result<PathBuf, String> {
    let validated_url = validate_video_url(url)?;
    let is_douyin = douyin::is_douyin_host(&validated_url);
    update_stage(
        app,
        state,
        job_id,
        JobStage::ResolvingUrl,
        None,
        Some(1.0),
        "正在解析视频链接",
    );

    let download_url = if is_douyin {
        let cancellation = state
            .cancellation_notifier(job_id)
            .ok_or_else(|| "找不到任务控制状态".to_string())?;
        ensure_not_cancelled(state, job_id)?;
        let resolved = tokio::select! {
            result = douyin::resolve_video_url(validated_url.as_str()) => result?,
            _ = cancellation.notified() => return Err("任务已取消".into()),
        };
        ensure_not_cancelled(state, job_id)?;
        resolved.to_string()
    } else {
        validated_url.to_string()
    };

    let output_template = job_dir.join("source.%(ext)s");
    let args = vec![
        "--ignore-config".into(),
        "--no-playlist".into(),
        "--no-simulate".into(),
        "--no-warnings".into(),
        "--newline".into(),
        "--progress".into(),
        "--fixup".into(),
        "never".into(),
        "--format".into(),
        "best".into(),
        "--progress-template".into(),
        "download:%(progress._percent_str)s".into(),
        "--output".into(),
        output_template.as_os_str().to_owned(),
        OsString::from(download_url),
    ];

    let progress_app = app.clone();
    let progress_state = state.clone();
    let progress_job_id = job_id.to_string();
    let result = run_sidecar(
        app,
        state,
        job_id,
        "yt-dlp",
        args,
        move |line, _is_stderr| {
            if let Some(progress) = parse_ytdlp_progress(line) {
                update_stage(
                    &progress_app,
                    &progress_state,
                    &progress_job_id,
                    JobStage::Downloading,
                    Some(progress),
                    Some(2.0 + progress * 0.23),
                    &format!("正在下载视频 {}%", progress.round()),
                );
            }
        },
    )
    .await;
    match result {
        Ok(_) => {}
        Err(error) if !is_douyin => return Err(map_tiktok_download_error(&error)),
        Err(error) => return Err(error),
    }
    first_media_file(job_dir)
}

fn map_tiktok_download_error(error: &str) -> String {
    if error == "任务已取消" {
        return error.to_string();
    }

    let normalized = error.to_ascii_lowercase();
    let detail = compact_error_detail(error);
    if [
        "curl: (35)",
        "tls connect",
        "ssl_connect",
        "err_connection_closed",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return format!(
            "当前网络或代理关闭了 TikTok 连接，请先确认浏览器能打开该链接。原始原因：{detail}"
        );
    }
    if [
        "login required",
        "login is required",
        "login_required",
        "requires login",
        "requiring login",
        "log in",
        "sign in",
        "private",
        "permission to view",
        "account is required",
        "cookies are needed",
        "cookies required",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return format!(
            "该 TikTok 视频需要登录、属于私密内容，或当前账号无权访问。原始原因：{detail}"
        );
    }
    if [
        "video unavailable",
        "video not available",
        "this video is unavailable",
        "has been removed",
        "http error 404",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return format!("该 TikTok 视频已删除、不可用或当前地区无法访问。原始原因：{detail}");
    }
    error.to_string()
}

fn compact_error_detail(error: &str) -> String {
    error
        .lines()
        .rev()
        .find_map(|line| {
            let line = line.trim();
            (!line.is_empty()).then(|| line.chars().take(240).collect())
        })
        .unwrap_or_else(|| "未知错误".into())
}

async fn probe_duration(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    source_path: &Path,
) -> Result<Option<f64>, String> {
    let args = vec![
        "-v".into(),
        "error".into(),
        "-show_entries".into(),
        "stream=codec_type,duration:format=duration".into(),
        "-of".into(),
        "json".into(),
        source_path.as_os_str().to_owned(),
    ];
    let output = collect_sidecar(app, state, job_id, "ffprobe", args).await?;
    let probe: ProbeOutput = serde_json::from_str(&output.stdout)
        .map_err(|error| format!("无法解析视频信息：{error}"))?;
    let has_audio = probe
        .streams
        .iter()
        .any(|stream| stream.codec_type.as_deref() == Some("audio"));
    if !has_audio {
        return Err("视频中未检测到音轨".into());
    }

    Ok(probe_duration_seconds(&probe))
}

fn probe_duration_seconds(probe: &ProbeOutput) -> Option<f64> {
    let parse_duration = |value: &str| {
        value
            .parse::<f64>()
            .ok()
            .filter(|duration| duration.is_finite() && *duration > 0.0)
    };
    probe
        .format
        .as_ref()
        .and_then(|format| format.duration.as_deref())
        .and_then(parse_duration)
        .or_else(|| {
            probe
                .streams
                .iter()
                .filter_map(|stream| stream.duration.as_deref())
                .find_map(parse_duration)
        })
}

async fn extract_audio(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    source_path: &Path,
    wav_path: &Path,
    duration: Option<f64>,
) -> Result<(), String> {
    update_stage(
        app,
        state,
        job_id,
        JobStage::ExtractingAudio,
        None,
        Some(25.0),
        "正在提取音频",
    );
    let args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-i".into(),
        source_path.as_os_str().to_owned(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        wav_path.as_os_str().to_owned(),
    ];
    let progress_app = app.clone();
    let progress_state = state.clone();
    let progress_job_id = job_id.to_string();
    run_sidecar(
        app,
        state,
        job_id,
        "ffmpeg",
        args,
        move |line, _is_stderr| {
            if let Some(progress) =
                duration.and_then(|duration| parse_ffmpeg_progress(line, duration))
            {
                update_stage(
                    &progress_app,
                    &progress_state,
                    &progress_job_id,
                    JobStage::ExtractingAudio,
                    Some(progress),
                    Some(25.0 + progress * 0.13),
                    &format!("正在提取音频 {}%", progress.round()),
                );
            }
        },
    )
    .await?;

    if !wav_path.is_file() {
        return Err("音频提取完成，但没有生成临时音频".into());
    }
    Ok(())
}

fn update_stage(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    stage: JobStage,
    stage_progress: Option<f64>,
    overall_progress: Option<f64>,
    message: &str,
) {
    if let Some(snapshot) = state.update_job(job_id, |job| {
        job.stage = stage;
        job.stage_progress = stage_progress.map(|value| value.clamp(0.0, 100.0));
        job.overall_progress = overall_progress.map(|value| value.clamp(0.0, 100.0));
        job.message = message.into();
    }) {
        emit(app, &snapshot);
    }
}

fn finish_failed(app: &AppHandle, state: &AppState, job_id: &str, error: String) {
    if let Some(snapshot) = state.replace_job(job_id, |job| {
        if job.stage == JobStage::Cancelled {
            return;
        }
        job.stage = JobStage::Failed;
        job.stage_progress = None;
        job.message = "字幕提取失败".into();
        job.error = Some(error);
    }) {
        emit(app, &snapshot);
    }
}

fn emit(app: &AppHandle, snapshot: &JobSnapshot) {
    if let Err(error) = app.emit("job://updated", snapshot) {
        log::warn!("Failed to emit job update: {error}");
    }
}

fn ensure_not_cancelled(state: &AppState, job_id: &str) -> Result<(), String> {
    if state.is_cancelled(job_id) {
        Err("任务已取消".into())
    } else {
        Ok(())
    }
}

fn model_path(_app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("models")
            .join(MODEL_FILE_NAME))
    }
    #[cfg(not(debug_assertions))]
    {
        _app.path()
            .resource_dir()
            .map(|path| path.join("models").join(MODEL_FILE_NAME))
            .map_err(|error| format!("无法定位字幕模型：{error}"))
    }
}

fn job_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位任务缓存目录：{error}"))?
        .join("jobs");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建任务缓存目录：{error}"))?;
    Ok(root)
}

fn output_reservation_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位字幕输出锁目录：{error}"))?
        .join("output-reservations");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建字幕输出锁目录：{error}"))?;
    Ok(root)
}

fn create_owned_job_dir(path: &Path) -> Result<(), String> {
    fs::create_dir(path).map_err(|error| format!("无法创建任务临时目录：{error}"))?;
    fs::write(path.join(OWNERSHIP_MARKER), b"subtitle-extractor\n")
        .map_err(|error| format!("无法标记任务临时目录：{error}"))
}

fn cleanup_owned_job_dir(root: &Path, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("无法验证任务缓存目录：{error}"))?;
    let canonical_path =
        fs::canonicalize(path).map_err(|error| format!("无法验证任务临时目录：{error}"))?;
    if !canonical_path.starts_with(&canonical_root)
        || canonical_path == canonical_root
        || !canonical_path.join(OWNERSHIP_MARKER).is_file()
    {
        return Err("拒绝清理不属于本应用的目录".into());
    }
    fs::remove_dir_all(canonical_path).map_err(|error| format!("无法清理任务临时目录：{error}"))
}

pub fn cleanup_orphaned_jobs(app: &AppHandle) -> Result<(), String> {
    let root = job_cache_root(app)?;
    for entry in fs::read_dir(&root).map_err(|error| format!("无法读取任务缓存目录：{error}"))?
    {
        let path = entry
            .map_err(|error| format!("无法读取任务缓存项：{error}"))?
            .path();
        if path.is_dir() && path.join(OWNERSHIP_MARKER).is_file() {
            cleanup_owned_job_dir(&root, &path)?;
        }
    }
    Ok(())
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "路径不是有效 UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn cleans_only_owned_job_directories() {
        let root = tempdir().unwrap();
        let owned = root.path().join("job-owned");
        create_owned_job_dir(&owned).unwrap();
        fs::write(owned.join("audio.wav"), b"test").unwrap();
        cleanup_owned_job_dir(root.path(), &owned).unwrap();
        assert!(!owned.exists());

        let foreign = root.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        assert!(cleanup_owned_job_dir(root.path(), &foreign).is_err());
        assert!(foreign.exists());
    }

    #[test]
    fn falls_back_to_valid_stream_duration() {
        let probe: ProbeOutput = serde_json::from_str(
            r#"{
                "format": { "duration": "N/A" },
                "streams": [
                    { "codec_type": "video", "duration": "N/A" },
                    { "codec_type": "audio", "duration": "15.25" }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(probe_duration_seconds(&probe), Some(15.25));
    }

    #[test]
    fn maps_tiktok_tls_failures_to_actionable_chinese() {
        for error in [
            "yt-dlp 执行失败：curl: (35) TLS connect error: invalid library",
            "yt-dlp 执行失败：BoringSSL SSL_connect: SSL_ERROR_SYSCALL",
            "yt-dlp 执行失败：ERR_CONNECTION_CLOSED",
        ] {
            let mapped = map_tiktok_download_error(error);
            assert!(mapped.starts_with("当前网络或代理关闭了 TikTok 连接"));
            assert!(mapped.contains("原始原因："));
        }
    }

    #[test]
    fn maps_tiktok_access_and_availability_failures() {
        let private = map_tiktok_download_error(
            "yt-dlp 执行失败：This video is private. Log in with an account that has permission to view it",
        );
        assert!(private.starts_with("该 TikTok 视频需要登录、属于私密内容"));
        assert!(private.contains("permission to view"));

        let unavailable = map_tiktok_download_error("yt-dlp 执行失败：This video is unavailable");
        assert!(unavailable.starts_with("该 TikTok 视频已删除、不可用"));
        assert!(unavailable.contains("This video is unavailable"));
    }

    #[test]
    fn leaves_unknown_tiktok_and_cancellation_errors_unchanged() {
        for error in ["任务已取消", "yt-dlp 执行失败：unexpected parser error"] {
            assert_eq!(map_tiktok_download_error(error), error);
        }
    }
}
