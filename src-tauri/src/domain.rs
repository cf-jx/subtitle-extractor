use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Local,
    Url,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Txt,
    Srt,
    Vtt,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Srt => "srt",
            Self::Vtt => "vtt",
        }
    }
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
    pub txt: Option<String>,
    pub srt: Option<String>,
    pub vtt: Option<String>,
}

impl OutputFiles {
    pub fn merge(&mut self, other: Self) {
        if other.txt.is_some() {
            self.txt = other.txt;
        }
        if other.srt.is_some() {
            self.srt = other.srt;
        }
        if other.vtt.is_some() {
            self.vtt = other.vtt;
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub revision: u64,
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
    pub export_format: ExportFormat,
    pub include_timestamps: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTranscriptRequest {
    pub job_id: String,
    pub segments: Vec<TranscriptSegment>,
    pub export_format: ExportFormat,
    pub include_timestamps: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub platform: &'static str,
    pub model_name: &'static str,
    pub model_ready: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_new_exports_without_losing_existing_formats() {
        let mut files = OutputFiles {
            txt: Some("/tmp/transcript.txt".into()),
            srt: None,
            vtt: None,
        };
        files.merge(OutputFiles {
            txt: None,
            srt: Some("/tmp/transcript.srt".into()),
            vtt: None,
        });

        assert_eq!(files.txt.as_deref(), Some("/tmp/transcript.txt"));
        assert_eq!(files.srt.as_deref(), Some("/tmp/transcript.srt"));
        assert!(files.vtt.is_none());
    }
}
