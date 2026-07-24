use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Local,
    Url,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStage {
    Queued,
    ResolvingUrl,
    Downloading,
    ProbingMedia,
    ExtractingAudio,
    LoadingModel,
    Transcribing,
    Exporting,
    Completed,
    Failed,
    Cancelled,
}

impl JobStage {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub index: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputFiles {
    pub txt: String,
    pub srt: String,
    pub vtt: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub source_kind: SourceKind,
    pub source: String,
    pub display_name: String,
    pub output_dir: String,
    pub stage: JobStage,
    pub stage_progress: Option<f64>,
    pub overall_progress: Option<f64>,
    pub message: String,
    pub created_at: String,
    pub segments: Vec<TranscriptSegment>,
    pub outputs: Option<OutputFiles>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobRequest {
    pub source_kind: SourceKind,
    pub source: String,
    pub output_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTranscriptRequest {
    pub job_id: String,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub platform: &'static str,
    pub model_name: &'static str,
    pub model_ready: bool,
}
