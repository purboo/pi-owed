//! The `owedmc` command line (the binary in `formal/models` passes its registry to [`main`]).

use crate::{Consts, DynReport, Options, Registry, SimOptions, Verdict, engine_version, json};
use std::io::Write;
use std::time::Duration;

pub const USAGE: &str = "\
usage: owedmc list
       owedmc check <model> [--mode M] [--prop P]... [--all] [--const K=V]... [--workers N] [--deadlock]
                    [--simulate traces=N,depth=D,seed=S] [--max-states N] [--timeout S] [--trace] [--json]
One line per property: <model> <mode> <prop> <HOLDS|VIOLATED|HOLDS-SIM|TIMEOUT|ERROR> <N distinct states>.
Exit status: number of ERROR/TIMEOUT results, at most 255 (64 = usage error).";

/// Exit status for usage errors.
pub const EXIT_USAGE: i32 = 64;

/// Exit statuses are capped here (a process exit status is one byte; larger counts must not wrap to 0).
pub const MAX_EXIT: usize = 255;

#[derive(Debug, Default)]
struct Args {
    model: String,
    mode: Option<String>,
    props: Vec<String>,
    all: bool,
    consts: Vec<String>,
    workers: Option<usize>,
    deadlock: bool,
    simulate: Option<SimOptions>,
    max_states: Option<u64>,
    timeout: Option<f64>,
    trace: bool,
    json: bool,
}

fn parse_sim(s: &str) -> Result<SimOptions, String> {
    let mut o = SimOptions::default();
    for part in s.split(',').filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=').ok_or_else(|| format!("--simulate: {part:?} is not key=value"))?;
        let n: u64 = v.parse().map_err(|_| format!("--simulate: {k}={v} is not a number"))?;
        match k {
            "traces" | "num" => o.traces = n,
            "depth" => o.depth = u32::try_from(n).map_err(|_| "--simulate: depth too large".to_string())?,
            "seed" => o.seed = n,
            _ => return Err(format!("--simulate: unknown key {k}")),
        }
    }
    Ok(o)
}

fn parse_check(a: &[String]) -> Result<Args, String> {
    let mut r = Args::default();
    let mut it = a.iter();
    fn need(it: &mut std::slice::Iter<String>, flag: &str) -> Result<String, String> {
        it.next().cloned().ok_or_else(|| format!("{flag} needs a value"))
    }
    while let Some(x) = it.next() {
        match x.as_str() {
            "--mode" => r.mode = Some(need(&mut it, x)?),
            "--prop" => r.props.push(need(&mut it, x)?),
            "--all" => r.all = true,
            "--const" => r.consts.push(need(&mut it, x)?),
            "--workers" => {
                let v = need(&mut it, x)?;
                let n: usize = v.parse().map_err(|_| format!("--workers {v} is not a number"))?;
                if n == 0 {
                    return Err("--workers must be at least 1".to_string());
                }
                r.workers = Some(n);
            }
            "--deadlock" => r.deadlock = true,
            "--simulate" => r.simulate = Some(parse_sim(&need(&mut it, x)?)?),
            "--max-states" => {
                let v = need(&mut it, x)?;
                r.max_states = Some(v.parse().map_err(|_| format!("--max-states {v} is not a number"))?);
            }
            "--timeout" => {
                let v = need(&mut it, x)?;
                let t: f64 = v.parse().map_err(|_| format!("--timeout {v} is not a number of seconds"))?;
                if !(t.is_finite() && t >= 0.0) {
                    return Err(format!("--timeout {v} is not a number of seconds"));
                }
                r.timeout = Some(t);
            }
            "--trace" => r.trace = true,
            "--json" => r.json = true,
            f if f.starts_with('-') => return Err(format!("unknown flag {f}")),
            m if r.model.is_empty() => r.model = m.to_string(),
            extra => return Err(format!("unexpected argument {extra}")),
        }
    }
    if r.model.is_empty() {
        return Err("check needs a model name".to_string());
    }
    Ok(r)
}

/// Run the command line; returns the exit status. Output goes to `out`.
pub fn main(reg: &Registry, args: &[String], out: &mut dyn Write) -> i32 {
    match args.first().map(String::as_str) {
        Some("list") => {
            for m in reg.list() {
                let consts: Vec<String> = m.consts.iter().map(|(k, v)| format!("{k}={v}")).collect();
                let props = match m.instantiate(None, &mut Consts::new()) {
                    Ok(dm) => dm.property_list().iter().map(|(n, k)| format!("{n}({})", k.as_str())).collect::<Vec<_>>().join(" "),
                    Err(e) => format!("<cannot build default: {e}>"),
                };
                let _ = writeln!(out, "{}\t{}", m.name, m.about);
                let _ = writeln!(out, "  modes: {}", m.modes.join(" "));
                let _ = writeln!(out, "  consts: {}", consts.join(" "));
                let _ = writeln!(out, "  properties ({} mode): {props}", m.default_mode());
            }
            0
        }
        Some("check") => match parse_check(&args[1..]) {
            Ok(a) => run_check(reg, &a, out),
            Err(e) => {
                let _ = writeln!(out, "owedmc: {e}\n{USAGE}");
                EXIT_USAGE
            }
        },
        Some("help") | Some("--help") | Some("-h") => {
            let _ = writeln!(out, "{USAGE}");
            0
        }
        _ => {
            let _ = writeln!(out, "{USAGE}");
            EXIT_USAGE
        }
    }
}

fn table_line(model: &str, mode: &str, prop: &str, result: &str, count: &str) -> String {
    format!("{model:<16} {mode:<6} {prop:<22} {result:<9} {count}")
}

fn run_check(reg: &Registry, a: &Args, out: &mut dyn Write) -> i32 {
    let Some(info) = reg.get(&a.model) else {
        let _ = writeln!(out, "owedmc: unknown model {} (see owedmc list)", a.model);
        return EXIT_USAGE;
    };
    let mode = a.mode.clone().unwrap_or_else(|| info.default_mode().to_string());
    let mut consts = match Consts::parse(&a.consts) {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(out, "owedmc: {e}");
            return EXIT_USAGE;
        }
    };
    let engine = engine_version();
    let sha = info.source_sha256();
    let workers = a.workers.unwrap_or(4);
    let opts = Options {
        workers,
        deadlock: a.deadlock,
        props: if a.all { Vec::new() } else { a.props.clone() },
        max_states: a.max_states,
        timeout: a.timeout.map(Duration::from_secs_f64),
        simulate: a.simulate.clone(),
    };
    let flags = format!(
        "workers={} deadlock={} {} max-states={} timeout={}",
        workers,
        if a.deadlock { "on" } else { "off" },
        match &a.simulate {
            Some(s) => format!("simulate(traces={},depth={},seed={})", s.traces, s.depth, s.seed),
            None => "exhaustive".to_string(),
        },
        a.max_states.map_or("none".to_string(), |n| n.to_string()),
        a.timeout.map_or("none".to_string(), |t| format!("{t}s")),
    );
    let built = info.instantiate(Some(&mode), &mut consts);
    let resolved: Vec<String> = consts.resolved().iter().map(|(k, v)| format!("{k}={v}")).collect();
    let report: Result<DynReport, String> = built.map(|m| m.check_dyn(&opts));

    if a.json {
        let mut fields: Vec<(&str, String)> = vec![
            ("model", json::string(info.name)),
            ("mode", json::string(&mode)),
            (
                "consts",
                json::object(
                    &consts.resolved().iter().map(|(k, v)| (k.as_str(), json::string(v))).collect::<Vec<_>>(),
                ),
            ),
            ("engine", json::string(&engine)),
            ("source", json::object(&[("file", json::string(info.source_file)), ("sha256", json::string(&sha))])),
            ("flags", json::string(&flags)),
        ];
        let errors = match &report {
            Err(e) => {
                fields.push(("error", json::string(e)));
                1
            }
            Ok(r) => {
                let s = &r.stats;
                fields.push((
                    "stats",
                    json::object(&[
                        ("distinct", s.distinct.to_string()),
                        ("generated", s.generated.to_string()),
                        ("depth", s.depth.to_string()),
                        ("seconds", json::float(s.elapsed.as_secs_f64())),
                        ("collision", json::float(s.collision)),
                        ("workers", s.workers.to_string()),
                        ("simulated", s.simulated.to_string()),
                        ("complete", s.complete.to_string()),
                        ("limit", json::opt_string(s.limit.as_deref())),
                        ("traces", s.traces.to_string()),
                    ]),
                ));
                let results: Vec<String> = r
                    .results
                    .iter()
                    .map(|p| {
                        let mut f = vec![
                            ("prop", json::string(&p.name)),
                            ("kind", json::string(p.kind.as_str())),
                            ("result", json::string(p.verdict.as_str())),
                            ("message", json::opt_string(p.message.as_deref())),
                        ];
                        if let Some(t) = &p.trace {
                            f.push(("trace_length", t.steps.len().to_string()));
                            if a.trace {
                                let steps: Vec<String> = t
                                    .steps
                                    .iter()
                                    .map(|(act, st)| {
                                        json::object(&[("action", json::opt_string(act.as_deref())), ("state", json::string(st))])
                                    })
                                    .collect();
                                f.push(("trace", json::array(&steps)));
                                f.push(("loop_start", t.loop_start.map_or("null".to_string(), |l| l.to_string())));
                                f.push(("stutter", t.stutter.to_string()));
                            }
                        }
                        json::object(&f)
                    })
                    .collect();
                fields.push(("results", json::array(&results)));
                error_count(r)
            }
        };
        fields.push(("errors", errors.to_string()));
        let _ = writeln!(out, "{}", json::object(&fields));
        return errors.min(MAX_EXIT) as i32;
    }

    let _ = writeln!(out, "# engine {engine}");
    let _ = writeln!(out, "# model  {} mode {} source {} sha256 {}", info.name, mode, info.source_file, sha);
    let _ = writeln!(out, "# consts {}", if resolved.is_empty() { "-".to_string() } else { resolved.join(" ") });
    let _ = writeln!(out, "# flags  {flags}");
    match report {
        Err(e) => {
            let _ = writeln!(out, "{}", table_line(info.name, &mode, "-", "ERROR", ""));
            let _ = writeln!(out, "# error: {e}");
            1
        }
        Ok(r) => {
            let s = &r.stats;
            let count = if s.simulated { format!("{} states sampled", s.generated) } else { format!("{} distinct states", s.distinct) };
            for p in &r.results {
                let _ = writeln!(out, "{}", table_line(info.name, &mode, &p.name, p.verdict.as_str(), &count));
            }
            let secs = s.elapsed.as_secs_f64();
            let _ = writeln!(
                out,
                "# stats  distinct={} generated={} depth={} time={:.3}s rate={:.0} states/s fp-collision~{:.1e} complete={}{}{}",
                s.distinct,
                s.generated,
                s.depth,
                secs,
                if secs > 0.0 { (if s.simulated { s.generated } else { s.distinct }) as f64 / secs } else { 0.0 },
                s.collision,
                if s.complete { "yes" } else { "no" },
                s.limit.as_ref().map_or(String::new(), |l| format!(" limit={l}")),
                if s.simulated { format!(" traces={}", s.traces) } else { String::new() },
            );
            for p in &r.results {
                if let Some(m) = &p.message {
                    let _ = writeln!(out, "# {} {}: {}", p.name, p.verdict, m);
                }
                if let Some(t) = &p.trace {
                    if a.trace {
                        let _ = writeln!(out, "# counterexample for {} ({} states):", p.name, t.steps.len());
                        let _ = write!(out, "{}", t.render());
                    } else {
                        let _ = writeln!(out, "# {} counterexample: {} states (--trace prints it)", p.name, t.steps.len());
                    }
                }
            }
            error_count(&r).min(MAX_EXIT) as i32
        }
    }
}

fn error_count(r: &DynReport) -> usize {
    r.results.iter().filter(|p| matches!(p.verdict, Verdict::Error | Verdict::Timeout)).count()
}
