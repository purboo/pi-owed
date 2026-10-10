//! Ports of the a3 TLA+ models (pi-dag formal/a3; copies in formal/reference/a3): `a3_auth` (PiDagAuth3) and
//! `a3_merge` (PiDagMerge), with the comparison against the recorded TLC runs (formal/reference/a3/tlc-runs.tsv).
//! PiDagEvidence is not ported. See formal/REPORT-mc-port.md.

pub mod auth;
pub mod compare;
pub mod merge;
pub mod tlc;

/// Register both a3 models.
pub fn register(r: &mut mc::Registry) {
    r.add(auth::info());
    r.add(merge::info());
}
