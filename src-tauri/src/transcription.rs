use std::{
    ffi::c_void,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use whisper_rs::{
    convert_integer_to_float_audio, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters, WhisperSysContext, WhisperSysState,
};

use crate::{
    domain::{JobStage, TranscriptSegment},
    state::AppState,
};

const MODEL_SHA256: &str = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";
const MODEL_BYTES: u64 = 190_085_487;

struct CallbackState {
    app: AppHandle,
    jobs: AppState,
    job_id: String,
    cancelled: Arc<AtomicBool>,
}

struct CallbackGuard(*mut CallbackState);

impl Drop for CallbackGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                drop(Box::from_raw(self.0));
            }
        }
    }
}

unsafe extern "C" fn progress_callback(
    _context: *mut WhisperSysContext,
    _state: *mut WhisperSysState,
    progress: std::ffi::c_int,
    user_data: *mut c_void,
) {
    if user_data.is_null() {
        return;
    }
    let callback = &*(user_data as *const CallbackState);
    let progress = f64::from(progress).clamp(0.0, 100.0);
    if let Some(snapshot) = callback.jobs.update_job(&callback.job_id, |job| {
        job.stage = JobStage::Transcribing;
        job.stage_progress = Some(progress);
        job.overall_progress = Some(40.0 + progress * 0.55);
        job.message = format!("正在识别字幕 {}%", progress.round());
    }) {
        let _ = callback.app.emit("job://updated", snapshot);
    }
}

unsafe extern "C" fn abort_callback(user_data: *mut c_void) -> bool {
    if user_data.is_null() {
        return false;
    }
    let callback = &*(user_data as *const CallbackState);
    callback.cancelled.load(Ordering::SeqCst)
}

pub fn load_model(model_path: &Path) -> Result<Arc<WhisperContext>, String> {
    verify_model(model_path)?;
    WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map(Arc::new)
        .map_err(|error| format!("加载字幕模型失败：{error}"))
}

pub fn verify_model(model_path: &Path) -> Result<(), String> {
    let metadata = model_path
        .metadata()
        .map_err(|_| format!("缺少本地字幕模型：{}", model_path.display()))?;
    if metadata.len() != MODEL_BYTES {
        return Err("本地字幕模型大小不正确，请重新安装应用".into());
    }

    let mut file =
        File::open(model_path).map_err(|error| format!("无法读取本地字幕模型：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("校验本地字幕模型失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != MODEL_SHA256 {
        return Err("本地字幕模型校验失败，请重新安装应用".into());
    }
    Ok(())
}

pub fn transcribe_wav(
    app: AppHandle,
    jobs: AppState,
    job_id: String,
    model: Arc<WhisperContext>,
    wav_path: PathBuf,
) -> Result<Vec<TranscriptSegment>, String> {
    let cancellation = jobs
        .cancellation_flag(&job_id)
        .ok_or_else(|| "找不到任务控制状态".to_string())?;
    if cancellation.load(Ordering::SeqCst) {
        return Err("任务已取消".into());
    }

    let reader =
        hound::WavReader::open(&wav_path).map_err(|error| format!("无法读取临时音频：{error}"))?;
    let specification = reader.spec();
    if specification.sample_rate != 16_000
        || specification.channels != 1
        || specification.bits_per_sample != 16
    {
        return Err("临时音频格式无效，必须是 16 kHz 单声道 PCM".into());
    }

    let integer_samples = reader
        .into_samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取临时音频失败：{error}"))?;
    let mut audio = vec![0.0_f32; integer_samples.len()];
    convert_integer_to_float_audio(&integer_samples, &mut audio)
        .map_err(|error| format!("转换音频样本失败：{error}"))?;
    drop(integer_samples);

    let mut state = model
        .create_state()
        .map_err(|error| format!("创建字幕识别状态失败：{error}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
    let thread_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4)
        .saturating_sub(1)
        .clamp(1, 8);
    params.set_n_threads(thread_count as i32);
    params.set_translate(false);
    params.set_language(None);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_token_timestamps(false);

    let user_data = Box::into_raw(Box::new(CallbackState {
        app,
        jobs,
        job_id,
        cancelled: cancellation,
    }));
    let guard = CallbackGuard(user_data);
    unsafe {
        params.set_progress_callback(Some(progress_callback));
        params.set_progress_callback_user_data(user_data.cast::<c_void>());
        params.set_abort_callback(Some(abort_callback));
        params.set_abort_callback_user_data(user_data.cast::<c_void>());
    }

    let transcription = state.full(params, &audio);
    drop(guard);
    transcription.map_err(|error| format!("识别字幕失败：{error}"))?;

    let segments = state
        .as_iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let text = segment.to_string().trim().to_string();
            (!text.is_empty()).then(|| TranscriptSegment {
                index: index + 1,
                start_ms: u64::try_from(segment.start_timestamp()).unwrap_or_default() * 10,
                end_ms: u64::try_from(segment.end_timestamp()).unwrap_or_default() * 10,
                text,
            })
        })
        .collect::<Vec<_>>();

    if segments.is_empty() {
        return Err("没有识别到可导出的语音内容".into());
    }
    Ok(segments)
}
