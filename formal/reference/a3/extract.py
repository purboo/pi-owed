#!/usr/bin/env python3
"""Extract the recorded TLC runs of runs/PiDagAuth3-* and runs/PiDagMerge-* into tlc-runs.tsv.

One row per (cfg, log) pair (plus the "-first" logs of a re-run, which share the cfg). Columns:
  log, module, sha8, mode, consts (other CONSTANTS from the cfg, K=V;...), prop, kind (INVARIANT|PROPERTY),
  search (bfs|sim), workers, result, distinct, generated, depth, trace_states, sim_traces, sim_checked,
  sim_num (TLC -simulate num=, per worker), sim_depth (-depth), deadlock (checked|off), class
`result` follows check.sh's classification but from the log text alone: HOLDS ("No error has been found"),
VIOLATED, HOLDS-SIM (simulation that printed "Finished in" without an error), INCOMPLETE (no final verdict:
TLC was stopped by the timeout or by hand). Numbers are TLC's last printed values (for INCOMPLETE runs the last
progress line). `class` says how the row is compared (see REPORT-mc-port.md):
  current        module text equals the reference module (PiDagAuth3 4e33cdf2, PiDagMerge 7972e7a8)
  auth-v1        PiDagAuth3 32122309 (the parent-accepted scenario round; PiDagAuth3-32122309.tla); its
                 Scope="scenarios" semantics are those of the current module (Scope defaults to scenarios here)
  merge-preruling PiDagMerge 65dadcf3 scripted run of a property whose definition the ruling did not change
  ruling-changed  65dadcf3 run of NoBypassedNegative/EscapeAttributable/DeferredDebtVisible (redefined by the
                 ruling) or a free/replay scenario of the superseded free model (source not retained)
  intermediate   another module version whose source was not retained (d38bdf07, a94efbec, e35f5310, 5d1a8fb4,
                 4d021af3)
Usage: python3 extract.py > tlc-runs.tsv   (run in formal/reference/a3)
"""
import glob, os, re, sys

CURRENT = {"PiDagAuth3": "4e33cdf2", "PiDagMerge": "7972e7a8"}
RULED = {"NoBypassedNegative", "EscapeAttributable", "DeferredDebtVisible"}


def num(s):
    return s.replace(",", "") if s else ""


rows = []
for log in sorted(glob.glob("runs/PiDag*-*.log")):
    name = os.path.basename(log)
    if not (name.startswith("PiDagAuth3-") or name.startswith("PiDagMerge-")):
        continue
    cfg = re.sub(r"-first\.log$", ".log", log)[:-4] + ".cfg"
    if not os.path.exists(cfg):
        continue  # driver/session logs, not one TLC run
    t = open(log, errors="replace").read()
    m = re.search(r"# module sha256 (\w+)", t)
    if not m:
        continue
    module = name.split("-")[0]
    sha8 = m.group(1)[:8]
    c = open(cfg).read()
    consts = {}
    for line in c.splitlines():
        mm = re.match(r"\s+(\w+) = (.*)$", line)
        if mm:
            consts[mm.group(1)] = mm.group(2).strip().strip('"')
    mode = consts.pop("Mode")
    for k in ["Owner", "P1", "P2", "W1", "W2", "O", "K0", "K1"]:
        consts.pop(k, None)
    pm = re.search(r"^(INVARIANT|PROPERTY) (\w+)", c, re.M)
    kind, prop = pm.group(1), pm.group(2)
    sim = "Random Simulation" in t or "-simulate" in t.split("\n")[2]
    w = re.search(r"with (\d+) workers?", t)
    workers = w.group(1) if w else ""
    if "No error has been found" in t:
        result = "HOLDS"
    elif re.search(r"is violated|was violated|Temporal properties were violated|Deadlock reached", t):
        result = "VIOLATED"
    elif sim and re.search(r"^Finished in ", t, re.M) and not re.search(r"^Error", t, re.M):
        result = "HOLDS-SIM"
    else:
        result = "INCOMPLETE"
    d = re.findall(r"([\d,]+) distinct states found", t)
    g = re.findall(r"([\d,]+) states generated, [\d,]+ distinct", t)
    dp = re.search(r"The depth of the complete state graph search is (\d+)", t)
    prog = re.findall(r"Progress\(\d+\) at [^:]*: ([\d,]+) states generated[^,]*, ([\d,]+) distinct states found", t)
    distinct = num(d[-1]) if d else (num(prog[-1][1]) if prog else "")
    generated = num(g[-1]) if g else (num(prog[-1][0]) if prog else "")
    trace = len(re.findall(r"^State \d+:", t, re.M))
    st = re.findall(r"([\d,]+) states checked, ([\d,]+) traces generated", t)
    sim_checked, sim_traces = (num(st[-1][0]), num(st[-1][1])) if (sim and st) else ("", "")
    if sim:
        distinct = ""
        gg = re.findall(r"The number of states generated: (\d+)", t)
        generated = gg[-1] if gg else ""
    if sha8 == CURRENT[module]:
        klass = "current"
    elif module == "PiDagAuth3" and sha8 == "32122309":
        klass = "auth-v1"
    elif module == "PiDagMerge" and sha8 == "65dadcf3":
        sc = consts.get("Scenario", "")
        if sc in ("free", "replayNegative", "replayDeferred") or prop in RULED:
            klass = "ruling-changed"
        elif prop == "NewEscapeAttributable" and sc != "oldDebt":
            klass = "ruling-changed"
        else:
            klass = "merge-preruling"
    else:
        klass = "intermediate"
    flags = re.search(r"# flags (.*)", t).group(1)
    sn = re.search(r"num=(\d+)", flags)
    sd = re.search(r"-depth (\d+)", flags)
    dl = "off" if "-deadlock" in flags.replace("<deadlock checked>", "") else "checked"
    cs = ";".join(f"{k}={v}" for k, v in sorted(consts.items()))
    rows.append([name, module, sha8, mode, cs, prop, kind, "sim" if sim else "bfs", workers, result, distinct,
                 generated, dp.group(1) if dp else "", str(trace), sim_traces, sim_checked,
                 sn.group(1) if sn else "", sd.group(1) if sd else "", dl, klass])

hdr = ["log", "module", "sha8", "mode", "consts", "prop", "kind", "search", "workers", "result", "distinct",
       "generated", "depth", "trace_states", "sim_traces", "sim_checked", "sim_num", "sim_depth", "deadlock",
       "class"]
print("\t".join(hdr))
for r in rows:
    print("\t".join(r))
