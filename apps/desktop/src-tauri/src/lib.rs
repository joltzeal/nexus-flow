#[cfg(not(debug_assertions))]
use std::sync::Mutex;

#[cfg(not(debug_assertions))]
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    time::Duration,
};
use tauri::Manager;
use tauri::WindowEvent;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg(not(debug_assertions))]
struct ApiSidecar(Mutex<Option<CommandChild>>);

#[cfg(not(debug_assertions))]
impl Drop for ApiSidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(not(debug_assertions))]
impl ApiSidecar {
    fn kill(&self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

#[cfg(not(debug_assertions))]
fn spawn_api_sidecar(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    log_sidecar_message(
        &data_dir,
        &format!("starting nexus-flow-api data_dir={}", data_dir.display()),
    );

    let (mut rx, child) = app
        .shell()
        .sidecar("nexus-flow-api")?
        .env("NEXUS_FLOW_API_HOST", "127.0.0.1")
        .env("NEXUS_FLOW_API_PORT", "8765")
        .env("NEXUS_FLOW_API_RELOAD", "false")
        .env("NEXUS_FLOW_DATA_DIR", data_dir.as_os_str())
        .spawn()?;

    log_sidecar_message(&data_dir, &format!("started nexus-flow-api pid={}", child.pid()));
    app.manage(ApiSidecar(Mutex::new(Some(child))));
    let log_dir = data_dir.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[nexus-flow-api] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stderr(line) => {
                    let message =
                        format!("[nexus-flow-api] {}", String::from_utf8_lossy(&line).trim_end());
                    eprintln!("{message}");
                    log_sidecar_message(&log_dir, &message);
                }
                CommandEvent::Error(error) => {
                    log_sidecar_message(&log_dir, &format!("sidecar stream error: {error}"))
                }
                CommandEvent::Terminated(payload) => log_sidecar_message(
                    &log_dir,
                    &format!(
                        "nexus-flow-api terminated code={:?} signal={:?}",
                        payload.code, payload.signal
                    ),
                ),
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg(not(debug_assertions))]
fn log_sidecar_message(data_dir: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("nexus-flow-sidecar.log"))
    {
        let _ = writeln!(file, "{message}");
    }
}

#[cfg(not(debug_assertions))]
fn send_backend_post(path: &str, read_timeout: Duration) -> std::io::Result<()> {
    let mut stream = TcpStream::connect_timeout(
        &"127.0.0.1:8765".parse().expect("valid backend address"),
        Duration::from_secs(2),
    )?;
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;

    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    Ok(())
}

#[cfg(not(debug_assertions))]
fn stop_backend() {
    let _ = send_backend_post("/api/tasks/runs/active/stop", Duration::from_secs(15));
    let _ = send_backend_post("/shutdown", Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(500));
}

#[cfg(not(debug_assertions))]
fn kill_api_sidecar<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    if let Some(sidecar) = app_handle.try_state::<ApiSidecar>() {
        sidecar.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            #[cfg(not(debug_assertions))]
            if let Err(error) = spawn_api_sidecar(_app) {
                let message = format!("failed to start nexus-flow-api sidecar: {error}");
                eprintln!("{message}");
                if let Ok(data_dir) = _app.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&data_dir);
                    log_sidecar_message(&data_dir, &message);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![greet]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            #[cfg(not(debug_assertions))]
            {
                stop_backend();
                kill_api_sidecar(_app_handle);
            }
        }
        _ => {}
    });
}
