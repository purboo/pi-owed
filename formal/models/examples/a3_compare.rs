//! Compare every recorded TLC run of the a3 models (formal/reference/a3/tlc-runs.tsv) with the ports.
//!
//!   cargo run --offline --release -p models --example a3_compare -- [--heavy] [--workers N] [--only SUBSTR]
//!       [--sim-traces N] [--seed S] [--sim-timeout S (default 900, TLC's limit)] [--all-classes]
//!
//! One TSV line per row: log, class, label, TLC (result distinct generated depth trace workers), owedmc (verdict
//! distinct generated depth trace), TLC-order search (distinct trace), OK/FAIL, failures and notes, seconds.
//! `--heavy` includes the free authority runs with MaxLog >= 3 (9.3e6 states). Rows of other module versions are
//! skipped unless `--all-classes` (they are then reported, not judged). Exit status: failed rows (at most 255).

use models::a3::compare::{Outcome, compare_bfs, compare_sim, reference};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut heavy = false;
    let mut all = false;
    let mut workers = 4usize;
    let mut only: Option<String> = None;
    let mut sim_traces: Option<u64> = None;
    let mut seed = 1u64;
    let mut sim_timeout: Option<f64> = Some(900.0);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--heavy" => heavy = true,
            "--all-classes" => all = true,
            "--workers" => workers = it.next().expect("--workers N").parse().expect("number"),
            "--only" => only = it.next().cloned(),
            "--sim-traces" => sim_traces = Some(it.next().expect("--sim-traces N").parse().expect("number")),
            "--seed" => seed = it.next().expect("--seed S").parse().expect("number"),
            "--sim-timeout" => sim_timeout = Some(it.next().expect("--sim-timeout S").parse().expect("seconds")),
            x => panic!("unknown argument {x}"),
        }
    }
    println!(
        "log\tclass\tlabel\ttlc_result\ttlc_distinct\ttlc_generated\ttlc_depth\ttlc_trace\ttlc_workers\tours\tours_distinct\tours_generated\tours_depth\tours_trace\ttlcorder_distinct\ttlcorder_trace\tstatus\tdetail\tseconds"
    );
    let mut failed = 0usize;
    let (mut ok, mut skipped) = (0usize, 0usize);
    for row in reference() {
        if only.as_ref().is_some_and(|o| !row.log.contains(o.as_str())) {
            continue;
        }
        if !all && !row.comparable() {
            skipped += 1;
            continue;
        }
        let out: Option<Outcome> = if row.search == "bfs" { compare_bfs(&row, workers, heavy) } else { compare_sim(&row, workers, sim_traces, seed, sim_timeout) };
        let Some(o) = out else {
            skipped += 1;
            continue;
        };
        let judged = row.comparable();
        let status = if !judged {
            "INFO"
        } else if o.ok() {
            ok += 1;
            "OK"
        } else {
            failed += 1;
            "FAIL"
        };
        let mut detail: Vec<String> = o.failures.clone();
        detail.extend(o.notes.iter().cloned());
        if row.search == "sim" {
            detail.push(format!("sampled {} walks, {} states", o.sim_traces, o.generated));
        }
        let s = |x: Option<u64>| x.map_or(String::new(), |v| v.to_string());
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.3}",
            row.log,
            row.class,
            row.label(),
            row.result,
            s(row.distinct),
            s(row.generated),
            row.depth.map_or(String::new(), |d| d.to_string()),
            row.trace_states,
            row.workers,
            o.verdict.map_or("-".to_string(), |v| v.to_string()),
            if row.search == "sim" { String::new() } else { o.distinct.to_string() },
            o.generated,
            if row.search == "sim" { String::new() } else { o.depth.to_string() },
            o.trace_states,
            o.tlc.as_ref().map_or(String::new(), |t| t.distinct.to_string()),
            o.tlc.as_ref().map_or(String::new(), |t| t.trace_states.to_string()),
            status,
            detail.join("; "),
            o.seconds
        );
    }
    eprintln!("a3_compare: {ok} OK, {failed} FAIL, {skipped} skipped");
    std::process::exit(failed.min(255) as i32);
}
