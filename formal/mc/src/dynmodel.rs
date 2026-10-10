//! Type-erased layer: models registered by name, built from a mode and constants, checked through [`DynModel`].

use crate::{Kind, Model, Options, Stats, Verdict, check};
use std::collections::BTreeMap;

/// Constants given on the command line (`--const K=V`). A model's `build` reads them with defaults; every read
/// value (given or default) is recorded for the run header, and constants nobody read are an error.
#[derive(Clone, Debug, Default)]
pub struct Consts {
    given: BTreeMap<String, String>,
    resolved: BTreeMap<String, String>,
}

impl Consts {
    pub fn new() -> Consts {
        Consts::default()
    }

    /// Parse `K=V` pairs.
    pub fn parse<S: AsRef<str>>(pairs: &[S]) -> Result<Consts, String> {
        let mut c = Consts::new();
        for p in pairs {
            let p = p.as_ref();
            let (k, v) = p.split_once('=').ok_or_else(|| format!("constant {p:?} is not K=V"))?;
            let k = k.trim();
            if k.is_empty() {
                return Err(format!("constant {p:?} has an empty name"));
            }
            if c.given.insert(k.to_string(), v.trim().to_string()).is_some() {
                return Err(format!("constant {k} given twice"));
            }
        }
        Ok(c)
    }

    pub fn set(&mut self, k: &str, v: &str) -> &mut Self {
        self.given.insert(k.to_string(), v.to_string());
        self
    }

    fn raw(&mut self, name: &str, default: String) -> String {
        let v = self.given.get(name).cloned().unwrap_or(default);
        self.resolved.insert(name.to_string(), v.clone());
        v
    }

    pub fn string(&mut self, name: &str, default: &str) -> String {
        self.raw(name, default.to_string())
    }

    pub fn int(&mut self, name: &str, default: i64) -> Result<i64, String> {
        let v = self.raw(name, default.to_string());
        v.parse().map_err(|_| format!("constant {name}={v} is not an integer"))
    }

    pub fn uint(&mut self, name: &str, default: u64) -> Result<u64, String> {
        let v = self.raw(name, default.to_string());
        v.parse().map_err(|_| format!("constant {name}={v} is not a non-negative integer"))
    }

    pub fn bool(&mut self, name: &str, default: bool) -> Result<bool, String> {
        let v = self.raw(name, default.to_string());
        match v.as_str() {
            "true" | "TRUE" | "1" => Ok(true),
            "false" | "FALSE" | "0" => Ok(false),
            _ => Err(format!("constant {name}={v} is not a boolean")),
        }
    }

    /// Every constant the model read, with its value (given or default).
    pub fn resolved(&self) -> &BTreeMap<String, String> {
        &self.resolved
    }

    /// Given constants the model did not read.
    pub fn unused(&self) -> Vec<String> {
        self.given.keys().filter(|k| !self.resolved.contains_key(*k)).cloned().collect()
    }
}

/// A trace with actions and states rendered as text (`{:?}` for actions, `{:#?}` for states).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DynTrace {
    pub steps: Vec<(Option<String>, String)>,
    pub loop_start: Option<usize>,
    pub stutter: bool,
}

#[derive(Clone, Debug)]
pub struct DynResult {
    pub name: String,
    pub kind: Kind,
    pub verdict: Verdict,
    pub trace: Option<DynTrace>,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DynReport {
    pub results: Vec<DynResult>,
    pub stats: Stats,
}

/// A model behind a trait object.
pub trait DynModel {
    fn property_list(&self) -> Vec<(&'static str, Kind)>;
    fn check_dyn(&self, opts: &Options) -> DynReport;
}

impl<M: Model> DynModel for M {
    fn property_list(&self) -> Vec<(&'static str, Kind)> {
        self.properties().iter().map(|p| (p.name(), p.kind())).collect()
    }
    fn check_dyn(&self, opts: &Options) -> DynReport {
        let r = check(self, opts);
        DynReport {
            results: r
                .results
                .iter()
                .map(|p| DynResult {
                    name: p.name.clone(),
                    kind: p.kind,
                    verdict: p.verdict,
                    trace: p.trace.as_ref().map(|t| t.to_dyn()),
                    message: p.message.clone(),
                })
                .collect(),
            stats: r.stats,
        }
    }
}

pub type BuildFn = fn(mode: &str, consts: &mut Consts) -> Result<Box<dyn DynModel>, String>;

/// A registered model.
#[derive(Clone)]
pub struct ModelInfo {
    pub name: &'static str,
    pub about: &'static str,
    /// Modes; the first is the default.
    pub modes: &'static [&'static str],
    /// Constants with their defaults (documentation for `owedmc list`).
    pub consts: &'static [(&'static str, &'static str)],
    /// Path of the model source (for the run header), e.g. `file!()`.
    pub source_file: &'static str,
    /// The model source, e.g. `include_str!("mymodel.rs")`; its sha256 is printed with every run.
    pub source: &'static str,
    pub build: BuildFn,
}

impl ModelInfo {
    pub fn default_mode(&self) -> &'static str {
        self.modes.first().copied().unwrap_or("default")
    }

    /// Build the model for `mode` (default mode when None). Rejects unknown modes and unread constants.
    pub fn instantiate(&self, mode: Option<&str>, consts: &mut Consts) -> Result<Box<dyn DynModel>, String> {
        let mode = mode.unwrap_or(self.default_mode());
        if !self.modes.is_empty() && !self.modes.contains(&mode) {
            return Err(format!("model {} has no mode {mode} (modes: {})", self.name, self.modes.join(", ")));
        }
        let m = (self.build)(mode, consts)?;
        let unused = consts.unused();
        if !unused.is_empty() {
            return Err(format!("model {} does not use constant(s) {}", self.name, unused.join(", ")));
        }
        Ok(m)
    }

    pub fn source_sha256(&self) -> String {
        crate::sha256::hex(self.source.as_bytes())
    }
}

/// Models by name.
#[derive(Clone, Default)]
pub struct Registry {
    models: Vec<ModelInfo>,
}

impl Registry {
    pub fn new() -> Registry {
        Registry::default()
    }
    /// Add a model; panics on a duplicate name (a programming error).
    pub fn add(&mut self, m: ModelInfo) -> &mut Self {
        assert!(self.get(m.name).is_none(), "model {} registered twice", m.name);
        self.models.push(m);
        self
    }
    pub fn get(&self, name: &str) -> Option<&ModelInfo> {
        self.models.iter().find(|m| m.name == name)
    }
    pub fn list(&self) -> &[ModelInfo] {
        &self.models
    }
}
