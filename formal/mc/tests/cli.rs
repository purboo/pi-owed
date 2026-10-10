//! The type-erased registry and the owedmc command line: table format, exit status, attribution, JSON.

mod common;
use common::*;
use mc::{Consts, DynModel, ModelInfo, Registry, cli};

fn build_counters(mode: &str, c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    let n = c.uint("N", 5)? as u32;
    let target = if mode == "target" { Some((c.uint("TX", 1)? as u32, c.uint("TY", 1)? as u32)) } else { None };
    Ok(Box::new(Counters { n, target, sum_limit: u32::MAX }))
}

fn build_dining(_mode: &str, _c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    Ok(Box::new(Dining { terminal_deadlock: false }))
}

const SOURCE: &str = include_str!("common/mod.rs");

fn registry() -> Registry {
    let mut r = Registry::new();
    r.add(ModelInfo {
        name: "counters",
        about: "two counters mod N",
        modes: &["plain", "target"],
        consts: &[("N", "5"), ("TX", "1"), ("TY", "1")],
        source_file: "tests/common/mod.rs",
        source: SOURCE,
        build: build_counters,
    });
    r.add(ModelInfo {
        name: "dining",
        about: "dining philosophers",
        modes: &["default"],
        consts: &[],
        source_file: "tests/common/mod.rs",
        source: SOURCE,
        build: build_dining,
    });
    r
}

fn run(args: &[&str]) -> (i32, String) {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let mut out = Vec::new();
    let code = cli::main(&registry(), &args, &mut out);
    (code, String::from_utf8(out).unwrap())
}

fn table(out: &str) -> Vec<Vec<String>> {
    out.lines().filter(|l| !l.starts_with('#')).map(|l| l.split_whitespace().map(String::from).collect()).collect()
}

/// One table line per property (`<model> <mode> <prop> <RESULT> <N> distinct states`), attribution header with
/// engine version, constants and the sha256 of the model source; exit 0 when nothing is ERROR/TIMEOUT.
#[test]
fn check_prints_table_and_attribution() {
    let (code, out) = run(&["check", "counters", "--const", "N=7", "--workers", "3"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("# engine owedmc "), "{out}");
    assert!(out.contains(&format!("sha256 {}", mc::sha256::hex(SOURCE.as_bytes()))), "{out}");
    assert!(out.contains("# consts N=7"), "{out}");
    let t = table(&out);
    let names: Vec<&str> = t.iter().map(|r| r[2].as_str()).collect();
    assert_eq!(names, ["InRange", "NotTarget", "SumBelow", "StepByOne", "NeverWrapX"]);
    for r in &t {
        assert_eq!(r[0], "counters");
        assert_eq!(r[1], "plain");
        assert_eq!(r[4], "49");
        assert_eq!(&r[5..], ["distinct", "states"]);
    }
    assert_eq!(t[0][3], "HOLDS");
    assert_eq!(t[4][3], "VIOLATED");
}

/// A violation is a result (exit 0); TIMEOUT and ERROR count toward the exit status; --trace prints the trace.
#[test]
fn exit_status_counts_errors_and_timeouts() {
    let (code, out) = run(&["check", "counters", "--mode", "target", "--const", "TX=2", "--prop", "NotTarget", "--trace"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("VIOLATED"));
    assert!(out.contains("State 1: <Initial>") && out.contains("State 4: <Inc"), "{out}");

    let (code, out) = run(&["check", "counters", "--const", "N=100", "--prop", "InRange", "--prop", "StepByOne", "--max-states", "50"]);
    assert_eq!(code, 2, "{out}");
    assert_eq!(table(&out).iter().filter(|r| r[3] == "TIMEOUT").count(), 2);

    let (code, out) = run(&["check", "counters", "--prop", "Nope", "--prop", "InRange"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("ERROR"));

    let (code, out) = run(&["check", "dining", "--deadlock"]);
    assert_eq!(code, 0, "{out}");
    assert!(table(&out).iter().any(|r| r[2] == "Deadlock" && r[3] == "VIOLATED"), "{out}");
}

/// Bad models, modes, constants and flags are reported, not silently ignored.
#[test]
fn usage_and_build_errors() {
    assert_eq!(run(&["check", "nosuch"]).0, cli::EXIT_USAGE);
    assert_eq!(run(&["check", "counters", "--bogus"]).0, cli::EXIT_USAGE);
    assert_eq!(run(&["frobnicate"]).0, cli::EXIT_USAGE);
    let (code, out) = run(&["check", "counters", "--mode", "nomode"]);
    assert_eq!(code, 1);
    assert!(out.contains("no mode nomode"), "{out}");
    let (code, out) = run(&["check", "counters", "--const", "TYPO=3"]);
    assert_eq!(code, 1);
    assert!(out.contains("does not use constant(s) TYPO"), "{out}");
    let (code, out) = run(&["list"]);
    assert_eq!(code, 0);
    assert!(out.contains("counters") && out.contains("InRange(invariant)") && out.contains("NeverWrapX(action)"), "{out}");
}

/// --json prints one summary object; --simulate labels counts as sampled and yields HOLDS-SIM.
#[test]
fn json_and_simulate_output() {
    let (code, out) = run(&["check", "counters", "--prop", "InRange", "--json"]);
    assert_eq!(code, 0);
    assert_eq!(out.trim().lines().count(), 1, "{out}");
    let o = out.trim();
    assert!(o.starts_with('{') && o.ends_with('}'));
    for frag in ["\"model\":\"counters\"", "\"result\":\"HOLDS\"", "\"distinct\":25", "\"errors\":0", "\"sha256\":\""] {
        assert!(o.contains(frag), "missing {frag} in {o}");
    }
    let (code, out) = run(&["check", "counters", "--prop", "InRange", "--simulate", "traces=10,depth=5,seed=3"]);
    assert_eq!(code, 0, "{out}");
    let t = table(&out);
    assert_eq!(t[0][3], "HOLDS-SIM");
    assert_eq!(t[0][4], "60");
    assert_eq!(&t[0][5..], ["states", "sampled"]);
}
