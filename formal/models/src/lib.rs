//! owedmc models. Each model is a module with an `info()` returning its [`mc::ModelInfo`]; [`registry`] lists
//! them for the `owedmc` command line.

pub mod a3;
pub mod toy;

/// All registered models.
pub fn registry() -> mc::Registry {
    let mut r = mc::Registry::new();
    r.add(toy::info());
    a3::register(&mut r);
    r
}
