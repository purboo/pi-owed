//! std-only PRNG: xoshiro256** seeded through splitmix64.

#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

pub fn splitmix64(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut x = seed;
        Rng { s: [splitmix64(&mut x), splitmix64(&mut x), splitmix64(&mut x), splitmix64(&mut x)] }
    }

    /// The generator of walk number `trace` of a run with `seed` (independent of the worker that runs it).
    pub fn for_trace(seed: u64, trace: u64) -> Rng {
        let mut x = seed ^ 0x5851_F42D_4C95_7F2D;
        let a = splitmix64(&mut x);
        let mut y = a ^ trace.wrapping_mul(0xD1B5_4A32_D192_ED03);
        Rng::new(splitmix64(&mut y))
    }

    pub fn next_u64(&mut self) -> u64 {
        let r = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        r
    }

    /// Uniform-ish integer in 0..n (multiply-shift; n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        ((self.next_u64() as u128 * n as u128) >> 64) as u64
    }
}
