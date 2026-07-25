mod domain;
mod douyin;
mod jobs;
mod state;
mod subtitles;
mod tools;
mod transcription;
mod validation;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            if let Err(error) = jobs::cleanup_orphaned_jobs(app.handle()) {
                log::warn!("Failed to clean orphaned jobs: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            jobs::get_app_info,
            jobs::list_jobs,
            jobs::start_job,
            jobs::cancel_job,
            jobs::export_transcript,
            jobs::open_output_directory,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            app_handle.state::<AppState>().cancel_all();
        }
    });
}
