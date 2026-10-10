//! SHA-256 test vectors (FIPS 180-2 examples / NIST CAVP).

use mc::sha256::{Sha256, hex};

#[test]
fn sha256_test_vectors() {
    assert_eq!(hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(
        hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    assert_eq!(
        hex(b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
        "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
    );
    // One million 'a', fed in uneven pieces to exercise buffering.
    let mut h = Sha256::new();
    let chunk = [b'a'; 997];
    let mut left = 1_000_000usize;
    while left > 0 {
        let n = left.min(chunk.len());
        h.update(&chunk[..n]);
        left -= n;
    }
    let d: String = h.finish().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(d, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    // Padding boundary: 55, 56 and 64 bytes.
    assert_eq!(hex(&[b'a'; 55]), "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
    assert_eq!(hex(&[b'a'; 56]), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
    assert_eq!(hex(&[b'a'; 64]), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
}
