//! LeadsTo (P ~> Q) under weak fairness on the explicit state graph.
//!
//! TLA+ semantics with `[][Next]_vars`: every behavior may stutter, so a state is also a cycle of length one
//! (the stutter step), which takes no fairness class. A cycle is weakly fair when every class that is enabled
//! in every state of the cycle is taken on the cycle. A class is enabled in a state when some successor that
//! differs from the state was produced by an action of that class.
//!
//! P ~> Q is violated iff some reachable state satisfies P /\ ~Q and a ~Q path from it reaches a fair ~Q
//! cycle. For weak fairness it suffices to test whole strongly connected components of the ~Q subgraph (the
//! cycle through all states and edges of the component has the smallest set of always-enabled classes and the
//! largest set of taken classes), singletons included (stutter).

use crate::Fp;
use crate::bfs::{Entry, NONE};
use std::collections::{HashMap, VecDeque};

pub(crate) const NO_CLASS: u8 = u8::MAX;
pub(crate) const MAX_CLASSES: usize = 64;
pub(crate) const MAX_LEADS: usize = 32;

/// Per explored state: P/Q bits of every LeadsTo property (bit 2j = P_j, bit 2j+1 = Q_j), enabled classes, depth.
pub(crate) struct NodeRec {
    pub(crate) r: u64,
    pub(crate) pq: u64,
    pub(crate) enabled: u64,
    pub(crate) depth: u32,
}

/// A non-stuttering transition between stored states (references as in the fingerprint store).
pub(crate) struct EdgeRec {
    pub(crate) src: u64,
    pub(crate) dst: u64,
    pub(crate) class: u8,
}

/// The explored graph with dense node ids. Adjacency lists keep `next` order, so traversals are deterministic.
pub(crate) struct Graph {
    n: usize,
    pub(crate) fps: Vec<Fp>,
    pub(crate) parent: Vec<u32>,
    depth: Vec<u32>,
    pq: Vec<u64>,
    enabled: Vec<u64>,
    off: Vec<usize>,
    dst: Vec<u32>,
    cls: Vec<u8>,
    roff: Vec<usize>,
    rsrc: Vec<u32>,
}

/// A lasso: from `start` (reached by BFS parent pointers) along `path` to the loop entry, then `cycle` back to it.
/// Each element is (target node, class of the transition). An empty `cycle` means stuttering at the entry.
pub(crate) struct Lasso {
    pub(crate) start: u32,
    pub(crate) path: Vec<(u32, u8)>,
    pub(crate) cycle: Vec<(u32, u8)>,
}

impl Graph {
    pub(crate) fn build(logs: &[&[Entry]], nodes: Vec<NodeRec>, edges: Vec<Vec<EdgeRec>>) -> Result<Graph, String> {
        let mut soff = vec![0usize; logs.len() + 1];
        for (i, l) in logs.iter().enumerate() {
            soff[i + 1] = soff[i] + l.len();
        }
        let n = soff[logs.len()];
        if n >= u32::MAX as usize {
            return Err("too many states for liveness checking (limit 2^32-1)".to_string());
        }
        let dense = |r: u64| soff[(r >> 32) as usize] + (r & 0xffff_ffff) as usize;
        let mut fps = Vec::with_capacity(n);
        let mut parent = Vec::with_capacity(n);
        for l in logs {
            for e in l.iter() {
                fps.push(e.fp);
                parent.push(if e.parent == NONE { u32::MAX } else { dense(e.parent) as u32 });
            }
        }
        let mut depth = vec![0u32; n];
        let mut pq = vec![0u64; n];
        let mut enabled = vec![0u64; n];
        for nr in nodes {
            let v = dense(nr.r);
            depth[v] = nr.depth;
            pq[v] = nr.pq;
            enabled[v] = nr.enabled;
        }
        let ne: usize = edges.iter().map(|e| e.len()).sum();
        let mut off = vec![0usize; n + 1];
        let mut roff = vec![0usize; n + 1];
        for es in &edges {
            for e in es {
                off[dense(e.src) + 1] += 1;
                roff[dense(e.dst) + 1] += 1;
            }
        }
        for v in 0..n {
            off[v + 1] += off[v];
            roff[v + 1] += roff[v];
        }
        let mut dst = vec![0u32; ne];
        let mut cls = vec![0u8; ne];
        let mut rsrc = vec![0u32; ne];
        let mut pos = off.clone();
        let mut rpos = roff.clone();
        // All edges of one source were pushed contiguously by one worker in `next` order: order is kept.
        for es in &edges {
            for e in es {
                let (s, d) = (dense(e.src), dense(e.dst));
                dst[pos[s]] = d as u32;
                cls[pos[s]] = e.class;
                pos[s] += 1;
                rsrc[rpos[d]] = s as u32;
                rpos[d] += 1;
            }
        }
        Ok(Graph { n, fps, parent, depth, pq, enabled, off, dst, cls, roff, rsrc })
    }

    fn edges(&self, v: usize) -> impl Iterator<Item = (usize, u8)> + '_ {
        (self.off[v]..self.off[v + 1]).map(move |e| (self.dst[e] as usize, self.cls[e]))
    }

    /// Strongly connected components of the subgraph induced by `allowed` (iterative Tarjan).
    fn scc(&self, allowed: &[bool]) -> (Vec<u32>, usize) {
        const UN: u32 = u32::MAX;
        let n = self.n;
        let mut index = vec![UN; n];
        let mut low = vec![0u32; n];
        let mut on = vec![false; n];
        let mut comp = vec![UN; n];
        let mut st: Vec<u32> = Vec::new();
        let mut cs: Vec<(u32, usize)> = Vec::new();
        let mut counter = 0u32;
        let mut nc = 0usize;
        for root in 0..n {
            if !allowed[root] || index[root] != UN {
                continue;
            }
            index[root] = counter;
            low[root] = counter;
            counter += 1;
            st.push(root as u32);
            on[root] = true;
            cs.push((root as u32, self.off[root]));
            while let Some(&(v, ei)) = cs.last() {
                let v = v as usize;
                if ei < self.off[v + 1] {
                    cs.last_mut().unwrap().1 = ei + 1;
                    let w = self.dst[ei] as usize;
                    if !allowed[w] {
                        continue;
                    }
                    if index[w] == UN {
                        index[w] = counter;
                        low[w] = counter;
                        counter += 1;
                        st.push(w as u32);
                        on[w] = true;
                        cs.push((w as u32, self.off[w]));
                    } else if on[w] {
                        low[v] = low[v].min(index[w]);
                    }
                } else {
                    cs.pop();
                    if let Some(&(u, _)) = cs.last() {
                        let u = u as usize;
                        low[u] = low[u].min(low[v]);
                    }
                    if low[v] == index[v] {
                        loop {
                            let w = st.pop().unwrap() as usize;
                            on[w] = false;
                            comp[w] = nc as u32;
                            if w == v {
                                break;
                            }
                        }
                        nc += 1;
                    }
                }
            }
        }
        (comp, nc)
    }

    /// Check LeadsTo number `j`. `order` lists class ids by class name (deterministic choices).
    pub(crate) fn analyze(&self, j: usize, order: &[usize]) -> Option<Lasso> {
        let n = self.n;
        let pbit = 1u64 << (2 * j);
        let qbit = 1u64 << (2 * j + 1);
        let allowed: Vec<bool> = (0..n).map(|v| self.pq[v] & qbit == 0).collect();
        let (comp, nc) = self.scc(&allowed);
        let mut inter = vec![u64::MAX; nc];
        let mut taken = vec![0u64; nc];
        for v in 0..n {
            if !allowed[v] {
                continue;
            }
            let c = comp[v] as usize;
            inter[c] &= self.enabled[v];
            for (w, k) in self.edges(v) {
                if allowed[w] && comp[w] as usize == c && k != NO_CLASS {
                    taken[c] |= 1u64 << k;
                }
            }
        }
        let fair: Vec<bool> = (0..nc).map(|c| inter[c] & !taken[c] == 0).collect();
        let bad: Vec<bool> = (0..n).map(|v| allowed[v] && fair[comp[v] as usize]).collect();
        // Backward reachability from fair components inside ~Q.
        let mut reach = bad.clone();
        let mut queue: VecDeque<usize> = (0..n).filter(|&v| bad[v]).collect();
        while let Some(w) = queue.pop_front() {
            for &u in &self.rsrc[self.roff[w]..self.roff[w + 1]] {
                let u = u as usize;
                if allowed[u] && !reach[u] {
                    reach[u] = true;
                    queue.push_back(u);
                }
            }
        }
        let start = (0..n)
            .filter(|&v| reach[v] && self.pq[v] & pbit != 0)
            .min_by_key(|&v| (self.depth[v], self.fps[v]))?;
        // Shortest ~Q path from start to a fair component.
        let mut prev: HashMap<usize, (usize, u8)> = HashMap::new();
        let mut q = VecDeque::from([start]);
        let mut seen: HashMap<usize, ()> = HashMap::from([(start, ())]);
        let mut entry = start;
        while let Some(v) = q.pop_front() {
            if bad[v] {
                entry = v;
                break;
            }
            for (w, k) in self.edges(v) {
                if allowed[w] && reach[w] && !seen.contains_key(&w) {
                    seen.insert(w, ());
                    prev.insert(w, (v, k));
                    q.push_back(w);
                }
            }
        }
        let mut path = Vec::new();
        let mut v = entry;
        while v != start {
            let (u, k) = prev[&v];
            path.push((v as u32, k));
            v = u;
        }
        path.reverse();
        // A fair cycle through the entry inside its component.
        let c = comp[entry];
        let in_comp = |v: usize| allowed[v] && comp[v] == c;
        let mut cycle: Vec<(u32, u8)> = Vec::new();
        let mut cur = entry;
        let mut inter_v = self.enabled[entry];
        let mut taken_v = 0u64;
        loop {
            let need = inter_v & !taken_v;
            if need == 0 {
                break;
            }
            let k = *order.iter().find(|&&k| need & (1u64 << k) != 0).expect("class order") as u8;
            let bit = 1u64 << k;
            let has_edge = |v: usize| self.edges(v).any(|(w, kk)| kk == k && in_comp(w));
            let (seg, goal) = self.bfs_in(cur, &in_comp, |v| self.enabled[v] & bit == 0 || has_edge(v));
            for &(w, kk) in &seg {
                inter_v &= self.enabled[w as usize];
                if kk != NO_CLASS {
                    taken_v |= 1u64 << kk;
                }
            }
            cycle.extend(seg);
            cur = goal;
            if self.enabled[cur] & bit != 0 {
                let w = self.edges(cur).find(|&(w, kk)| kk == k && in_comp(w)).map(|x| x.0).expect("class edge");
                cycle.push((w as u32, k));
                taken_v |= bit;
                inter_v &= self.enabled[w];
                cur = w;
            }
        }
        if cur != entry {
            let (seg, _) = self.bfs_in(cur, &in_comp, |v| v == entry);
            cycle.extend(seg);
        }
        Some(Lasso { start: start as u32, path, cycle })
    }

    /// Shortest path inside `inside` from `from` to the first node satisfying `goal` (BFS in adjacency order).
    fn bfs_in(&self, from: usize, inside: &dyn Fn(usize) -> bool, goal: impl Fn(usize) -> bool) -> (Vec<(u32, u8)>, usize) {
        let mut prev: HashMap<usize, (usize, u8)> = HashMap::new();
        let mut q = VecDeque::from([from]);
        let mut seen: HashMap<usize, ()> = HashMap::from([(from, ())]);
        let mut end = None;
        while let Some(v) = q.pop_front() {
            if goal(v) {
                end = Some(v);
                break;
            }
            for (w, k) in self.edges(v) {
                if inside(w) && !seen.contains_key(&w) {
                    seen.insert(w, ());
                    prev.insert(w, (v, k));
                    q.push_back(w);
                }
            }
        }
        let end = end.expect("goal inside a strongly connected component");
        let mut seg = Vec::new();
        let mut v = end;
        while v != from {
            let (u, k) = prev[&v];
            seg.push((v as u32, k));
            v = u;
        }
        seg.reverse();
        (seg, end)
    }
}
