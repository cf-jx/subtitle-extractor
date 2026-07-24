use std::{env, path::PathBuf, process::Command};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_macos_compiler_runtime();
    }

    tauri_build::build()
}

fn link_macos_compiler_runtime() {
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");

    let output = Command::new("xcrun")
        .args(["clang", "--print-resource-dir"])
        .output()
        .expect("Failed to locate the Apple Clang resource directory");

    if !output.status.success() {
        panic!(
            "Apple Clang failed with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let resource_directory = String::from_utf8(output.stdout)
        .expect("Apple Clang returned a non-UTF-8 resource directory");
    let runtime_archive = PathBuf::from(resource_directory.trim())
        .join("lib")
        .join("darwin")
        .join("libclang_rt.osx.a");

    if !runtime_archive.is_file() {
        panic!(
            "Apple Clang runtime archive was not found at {}",
            runtime_archive.display()
        );
    }

    println!("cargo:rustc-link-arg={}", runtime_archive.display());
}
