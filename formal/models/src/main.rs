//! owedmc: check a registered model. See `owedmc help` and formal/README.md.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let code = mc::cli::main(&models::registry(), &args, &mut out);
    std::process::exit(code);
}
