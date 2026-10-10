//! Records the engine's identity at build time (see `engine_version` in src/lib.rs):
//! - OWEDMC_BUILD_GIT: `git describe --always --dirty --tags` of the checkout, or "unknown" without git;
//! - OWEDMC_BUILD_SRC_SHA256: SHA-256 over the engine sources src/*.rs in file-name order, each as
//!   `<file name> NUL <length in decimal> NUL <contents>`.

#[allow(dead_code)]
#[path = "src/sha256.rs"]
mod sha256;

use std::path::Path;
use std::process::Command;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let src = dir.join("src");
    let mut files: Vec<_> = std::fs::read_dir(&src)
        .expect("read src/")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .collect();
    files.sort();
    let mut h = sha256::Sha256::new();
    for f in &files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let body = std::fs::read(f).expect("read source");
        h.update(name.as_bytes());
        h.update(&[0]);
        h.update(body.len().to_string().as_bytes());
        h.update(&[0]);
        h.update(&body);
        println!("cargo:rerun-if-changed={}", f.display());
    }
    let digest: String = h.finish().iter().map(|b| format!("{b:02x}")).collect();
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed=build.rs");

    let git = |args: &[&str]| -> Option<String> {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let describe = git(&["describe", "--always", "--dirty", "--tags"]).unwrap_or_else(|| "unknown".to_string());
    // Rebuild when HEAD or the index moves, so the recorded describe follows commits and staged changes.
    if let Some(gd) = git(&["rev-parse", "--absolute-git-dir"]) {
        for f in ["HEAD", "index"] {
            let p = Path::new(&gd).join(f);
            if p.exists() {
                println!("cargo:rerun-if-changed={}", p.display());
            }
        }
    }
    println!("cargo:rustc-env=OWEDMC_BUILD_GIT={describe}");
    println!("cargo:rustc-env=OWEDMC_BUILD_SRC_SHA256={digest}");
}
