use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use command_group::AsyncGroupChild;
use parking_lot::Mutex;
use tokio::sync::{Notify, Semaphore};
use whisper_rs::WhisperContext;

use crate::domain::JobSnapshot;

pub type ManagedChild = Arc<Mutex<AsyncGroupChild>>;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    jobs: Mutex<HashMap<String, JobSnapshot>>,
    controls: Mutex<HashMap<String, JobControl>>,
    model: Mutex<Option<Arc<WhisperContext>>>,
    queue: Arc<Semaphore>,
}

struct JobControl {
    cancelled: Arc<AtomicBool>,
    cancellation_notify: Arc<Notify>,
    child: Option<ManagedChild>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                jobs: Mutex::new(HashMap::new()),
                controls: Mutex::new(HashMap::new()),
                model: Mutex::new(None),
                queue: Arc::new(Semaphore::new(1)),
            }),
        }
    }
}

impl AppState {
    pub fn insert_job(&self, snapshot: JobSnapshot) {
        self.inner.controls.lock().insert(
            snapshot.id.clone(),
            JobControl {
                cancelled: Arc::new(AtomicBool::new(false)),
                cancellation_notify: Arc::new(Notify::new()),
                child: None,
            },
        );
        self.inner.jobs.lock().insert(snapshot.id.clone(), snapshot);
    }

    pub fn update_job<F>(&self, job_id: &str, update: F) -> Option<JobSnapshot>
    where
        F: FnOnce(&mut JobSnapshot),
    {
        let mut jobs = self.inner.jobs.lock();
        let snapshot = jobs.get_mut(job_id)?;
        if snapshot.stage.is_terminal() {
            return Some(snapshot.clone());
        }
        update(snapshot);
        snapshot.revision = snapshot.revision.saturating_add(1);
        Some(snapshot.clone())
    }

    pub fn replace_job<F>(&self, job_id: &str, update: F) -> Option<JobSnapshot>
    where
        F: FnOnce(&mut JobSnapshot),
    {
        let mut jobs = self.inner.jobs.lock();
        let snapshot = jobs.get_mut(job_id)?;
        update(snapshot);
        snapshot.revision = snapshot.revision.saturating_add(1);
        Some(snapshot.clone())
    }

    pub fn get_job(&self, job_id: &str) -> Option<JobSnapshot> {
        self.inner.jobs.lock().get(job_id).cloned()
    }

    pub fn list_jobs(&self) -> Vec<JobSnapshot> {
        let mut jobs = self.inner.jobs.lock().values().cloned().collect::<Vec<_>>();
        jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        jobs
    }

    pub fn cancellation_flag(&self, job_id: &str) -> Option<Arc<AtomicBool>> {
        self.inner
            .controls
            .lock()
            .get(job_id)
            .map(|control| control.cancelled.clone())
    }

    pub fn cancellation_notifier(&self, job_id: &str) -> Option<Arc<Notify>> {
        self.inner
            .controls
            .lock()
            .get(job_id)
            .map(|control| control.cancellation_notify.clone())
    }

    pub fn is_cancelled(&self, job_id: &str) -> bool {
        self.cancellation_flag(job_id)
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }

    pub fn set_child(&self, job_id: &str, child: ManagedChild) -> Result<(), String> {
        let outcome = {
            let mut controls = self.inner.controls.lock();
            match controls.get_mut(job_id) {
                Some(control) if control.cancelled.load(Ordering::SeqCst) => {
                    Err("任务已取消".to_string())
                }
                Some(control) => Ok(control.child.replace(child.clone())),
                None => Err("找不到任务控制状态".to_string()),
            }
        };

        match outcome {
            Ok(previous) => {
                if let Some(previous) = previous {
                    terminate_child(&previous);
                }
                Ok(())
            }
            Err(error) => {
                terminate_child(&child);
                Err(error)
            }
        }
    }

    pub fn clear_child(&self, job_id: &str) {
        if let Some(control) = self.inner.controls.lock().get_mut(job_id) {
            control.child.take();
        }
    }

    pub fn kill_child(&self, job_id: &str) {
        let child = self
            .inner
            .controls
            .lock()
            .get_mut(job_id)
            .and_then(|control| control.child.take());
        if let Some(child) = child {
            terminate_child(&child);
        }
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), String> {
        let (notify, child) = {
            let mut controls = self.inner.controls.lock();
            let control = controls
                .get_mut(job_id)
                .ok_or_else(|| "找不到任务".to_string())?;
            control.cancelled.store(true, Ordering::SeqCst);
            (control.cancellation_notify.clone(), control.child.take())
        };
        notify.notify_one();
        if let Some(child) = child {
            terminate_child(&child);
        }
        Ok(())
    }

    pub fn cancel_all(&self) {
        let controls = {
            let mut controls = self.inner.controls.lock();
            controls
                .values_mut()
                .map(|control| {
                    control.cancelled.store(true, Ordering::SeqCst);
                    (control.cancellation_notify.clone(), control.child.take())
                })
                .collect::<Vec<_>>()
        };
        for (notify, child) in controls {
            notify.notify_one();
            if let Some(child) = child {
                terminate_child(&child);
            }
        }
    }

    pub fn finish_control(&self, job_id: &str) {
        let child = self
            .inner
            .controls
            .lock()
            .remove(job_id)
            .and_then(|control| control.child);
        if let Some(child) = child {
            terminate_child(&child);
        }
    }

    pub fn queue(&self) -> Arc<Semaphore> {
        self.inner.queue.clone()
    }

    pub fn model(&self) -> Option<Arc<WhisperContext>> {
        self.inner.model.lock().clone()
    }

    pub fn set_model(&self, model: Arc<WhisperContext>) {
        *self.inner.model.lock() = Some(model);
    }
}

fn terminate_child(child: &ManagedChild) {
    let mut child = child.lock();
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{JobSnapshot, JobStage, SourceKind};

    fn queued_job() -> JobSnapshot {
        JobSnapshot {
            id: "job-1".into(),
            revision: 0,
            source_kind: SourceKind::Local,
            source: "/tmp/video.mp4".into(),
            display_name: "video.mp4".into(),
            output_dir: "/tmp".into(),
            stage: JobStage::Queued,
            stage_progress: None,
            overall_progress: Some(0.0),
            message: "等待处理".into(),
            created_at: "2026-07-24T12:00:00Z".into(),
            segments: Vec::new(),
            outputs: None,
            error: None,
        }
    }

    #[test]
    fn terminal_jobs_cannot_be_overwritten_by_progress_updates() {
        let state = AppState::default();
        state.insert_job(queued_job());
        state
            .update_job("job-1", |job| job.stage = JobStage::Cancelled)
            .unwrap();

        let snapshot = state
            .update_job("job-1", |job| job.stage = JobStage::Completed)
            .unwrap();
        assert_eq!(snapshot.stage, JobStage::Cancelled);
        assert_eq!(snapshot.revision, 1);
    }
}
