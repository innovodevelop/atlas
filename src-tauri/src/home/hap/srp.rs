// SRP-6a, the client half — what pair-setup M1..M4 actually computes.
//
// WHY THIS IS HAND-WRITTEN, AND WHY THAT IS THE CHEAP OPTION
// `srp` 0.6 is the only stable Rust crate and it cannot speak HAP. Three
// independent defects, read out of its source rather than its README:
//   • utils.rs computes M1 = H(A ‖ B ‖ K), carrying the author's own comment
//     "this doesn't follow the spec". HAP needs the real RFC 5054 M1.
//   • compute_u hashes A ‖ B unpadded while claiming PAD(); BigUint drops
//     leading zeros, so ~1 pairing in 128 would fail AT RANDOM — a worse
//     failure mode than always failing, because it looks like flaky hardware.
//   • client.rs returns the raw premaster secret as `key`; HAP needs K = H(S).
// Replacing those three is the entire client, so the dependency would buy only
// `modpow`. Same reasoning that made ws.rs a hand-written RFC 6455 client.
//
// WHY THE BIGNUM IS ALSO HAND-WRITTEN: `num-bigint` is in Cargo.lock but is
// not a DIRECT dependency of this crate, and src-tauri/Cargo.toml is owned by
// another agent. `mod bn` below is ~200 lines of fixed-width modular
// arithmetic with a slow, obviously-correct division-based reference and a
// fast Montgomery path, and a test that runs the two against each other on
// random inputs so the fast one is never trusted on its own.
//
// THE FIVE PADDING ASYMMETRIES — each of these is real, each is quoted from
// Apple's HomeKitADK `HAPOpenSSL.c`, and each fails only against a live
// accessory, so read them before changing anything:
//   1. k  = H(PAD(N) ‖ PAD(g))          — g padded to the FULL 384 bytes.
//                                          Calc_k, HAPOpenSSL.c:169-183
//   2. M1 hashes H(g) over the SINGLE byte 0x05, NOT PAD(g). Same file, 40
//      lines later: `uint8_t g[1]; BN_bn2binpad(gN->g, g, sizeof g);`
//                                          HAP_srp_proof_m1:286-320
//   3. u  = H(PAD(A) ‖ PAD(B))          — both full width.  :220-229
//   4. M1 hashes MIN(A) ‖ MIN(B)        — leading zero bytes STRIPPED. :311-314
//   5. K  = H(MIN(S))                   — leading zeros of S stripped. :275-278
//      and M2 = H(PAD(A) ‖ M1 ‖ K)      — A full width again.  :322-333
//
// The one thing published vectors CANNOT prove: RFC 5054 Appendix B stops at
// the premaster secret, because TLS derives its own finished messages. There
// is no published vector anywhere for HAP's M1/M2 or for K = H(MIN(S)). Those
// three are pinned by transcription from the ADK and by the loopback test in
// pairing.rs, and that is the largest verification gap in this module.

use sha2::{Digest, Sha512};

// ===========================================================================
// bn — fixed-width unsigned bignum, little-endian u64 limbs
// ===========================================================================

mod bn {
    use std::cmp::Ordering;

    pub type Nat = Vec<u64>;

    /// Big-endian bytes to limbs, trimmed to the limbs actually needed.
    pub fn from_be(bytes: &[u8]) -> Nat {
        let limbs = bytes.len().div_ceil(8).max(1);
        let mut out = vec![0u64; limbs];
        for (i, b) in bytes.iter().rev().enumerate() {
            out[i / 8] |= (*b as u64) << (8 * (i % 8));
        }
        out
    }

    /// Limbs to big-endian bytes, left-zero-padded to `len` — this is `PAD()`.
    /// `None` when the value does not fit, which is a caller bug rather than
    /// something a peer can provoke: every value we render has already been
    /// reduced mod N and N is `len` bytes wide.
    pub fn to_be(x: &[u64], len: usize) -> Option<Vec<u8>> {
        let mut out = vec![0u8; len];
        for i in 0..x.len() * 8 {
            let byte = ((x[i / 8] >> (8 * (i % 8))) & 0xFF) as u8;
            if i < len {
                out[len - 1 - i] = byte;
            } else if byte != 0 {
                return None;
            }
        }
        Some(out)
    }

    pub fn is_zero(a: &[u64]) -> bool {
        a.iter().all(|l| *l == 0)
    }

    pub fn cmp(a: &[u64], b: &[u64]) -> Ordering {
        let n = a.len().max(b.len());
        for i in (0..n).rev() {
            let x = *a.get(i).unwrap_or(&0);
            let y = *b.get(i).unwrap_or(&0);
            match x.cmp(&y) {
                Ordering::Equal => {}
                other => return other,
            }
        }
        Ordering::Equal
    }

    pub fn bits(a: &[u64]) -> usize {
        for i in (0..a.len()).rev() {
            if a[i] != 0 {
                return i * 64 + (64 - a[i].leading_zeros() as usize);
            }
        }
        0
    }

    pub fn bit(a: &[u64], i: usize) -> bool {
        a.get(i / 64).map(|l| (l >> (i % 64)) & 1 == 1).unwrap_or(false)
    }

    pub fn add(a: &[u64], b: &[u64]) -> Nat {
        let n = a.len().max(b.len());
        let mut out = vec![0u64; n + 1];
        let mut carry = 0u128;
        for (i, slot) in out.iter_mut().enumerate().take(n) {
            let s = *a.get(i).unwrap_or(&0) as u128 + *b.get(i).unwrap_or(&0) as u128 + carry;
            *slot = s as u64;
            carry = s >> 64;
        }
        out[n] = carry as u64;
        out
    }

    /// `a -= b`, discarding a final borrow. Every call site has already
    /// established `a >= b` (or is the Montgomery final-subtract, where the
    /// true value carries an implicit 2^(64·len) that makes it true).
    pub fn sub_assign_wrapping(a: &mut [u64], b: &[u64]) {
        let mut borrow = 0u64;
        for (i, slot) in a.iter_mut().enumerate() {
            let (d, b1) = slot.overflowing_sub(*b.get(i).unwrap_or(&0));
            let (d, b2) = d.overflowing_sub(borrow);
            *slot = d;
            borrow = (b1 as u64) | (b2 as u64);
        }
    }

    pub fn mul(a: &[u64], b: &[u64]) -> Nat {
        let mut out = vec![0u64; a.len() + b.len()];
        for i in 0..a.len() {
            let mut carry = 0u128;
            for j in 0..b.len() {
                let t = out[i + j] as u128 + a[i] as u128 * b[j] as u128 + carry;
                out[i + j] = t as u64;
                carry = t >> 64;
            }
            let mut k = i + b.len();
            // The product always fits in a.len()+b.len() limbs, so `carry`
            // reaches 0 before `k` runs off the end. The bound is belt and
            // braces: an out-of-range index here would be a panic.
            while carry > 0 && k < out.len() {
                let t = out[k] as u128 + carry;
                out[k] = t as u64;
                carry = t >> 64;
                k += 1;
            }
        }
        out
    }

    /// `a mod n`, by binary long division. Slow and obviously correct — it is
    /// the reference the Montgomery path is tested against, and it is what
    /// builds the Montgomery constants in the first place.
    pub fn rem(a: &[u64], n: &[u64]) -> Nat {
        let len = n.len();
        let mut r = vec![0u64; len + 1];
        for i in (0..bits(a)).rev() {
            let mut carry = 0u64;
            for limb in r.iter_mut() {
                let next = *limb >> 63;
                *limb = (*limb << 1) | carry;
                carry = next;
            }
            if bit(a, i) {
                r[0] |= 1;
            }
            if cmp(&r, n) != Ordering::Less {
                sub_assign_wrapping(&mut r, n);
            }
        }
        r.truncate(len);
        r
    }

    /// -n0^-1 mod 2^64, by Newton iteration. Doubles the correct bit count
    /// each round, so six rounds from 1 bit covers 64.
    fn neg_inv64(n0: u64) -> u64 {
        let mut x = 1u64;
        for _ in 0..6 {
            x = x.wrapping_mul(2u64.wrapping_sub(n0.wrapping_mul(x)));
        }
        x.wrapping_neg()
    }

    /// Montgomery arithmetic modulo an odd `n`.
    pub struct Mont {
        n: Nat,
        n0inv: u64,
        r2: Nat,
        len: usize,
    }

    impl Mont {
        /// `None` for an even or zero modulus — Montgomery needs n odd, and
        /// every SRP prime is.
        pub fn new(n_be: &[u8]) -> Option<Mont> {
            let n = from_be(n_be);
            if is_zero(&n) || n[0] & 1 == 0 {
                return None;
            }
            let len = n.len();
            let n0inv = neg_inv64(n[0]);
            let mut r = vec![0u64; len + 1];
            r[len] = 1;
            let r_mod = rem(&r, &n);
            let r2 = rem(&mul(&r_mod, &r_mod), &n);
            Some(Mont { n, n0inv, r2, len })
        }

        pub fn modulus(&self) -> &[u64] {
            &self.n
        }

        fn fit(&self, x: &[u64]) -> Nat {
            let mut v = rem(x, &self.n);
            v.resize(self.len, 0);
            v
        }

        /// CIOS Montgomery multiplication: returns a·b·R^-1 mod n.
        /// `a` and `b` must both be exactly `len` limbs and below `n`.
        fn mont_mul(&self, a: &[u64], b: &[u64]) -> Nat {
            let s = self.len;
            let n = &self.n;
            let mut t = vec![0u64; s + 2];
            for &b_limb in b.iter().take(s) {
                let bi = b_limb as u128;
                let mut c = 0u64;
                for j in 0..s {
                    let x = t[j] as u128 + a[j] as u128 * bi + c as u128;
                    t[j] = x as u64;
                    c = (x >> 64) as u64;
                }
                let x = t[s] as u128 + c as u128;
                t[s] = x as u64;
                t[s + 1] = (x >> 64) as u64;

                let m = t[0].wrapping_mul(self.n0inv) as u128;
                let x = t[0] as u128 + m * n[0] as u128;
                let mut c = (x >> 64) as u64;
                for j in 1..s {
                    let x = t[j] as u128 + m * n[j] as u128 + c as u128;
                    t[j - 1] = x as u64;
                    c = (x >> 64) as u64;
                }
                let x = t[s] as u128 + c as u128;
                t[s - 1] = x as u64;
                t[s] = t[s + 1] + (x >> 64) as u64;
                t[s + 1] = 0;
            }
            let mut r = t[..s].to_vec();
            if t[s] != 0 || cmp(&r, n) != Ordering::Less {
                sub_assign_wrapping(&mut r, n);
            }
            r
        }

        pub fn mul_mod(&self, a: &[u64], b: &[u64]) -> Nat {
            let a = self.fit(a);
            let b = self.fit(b);
            // mont_mul(a·R, b) = a·b — one conversion, not two.
            let am = self.mont_mul(&a, &self.r2);
            self.mont_mul(&am, &b)
        }

        pub fn add_mod(&self, a: &[u64], b: &[u64]) -> Nat {
            rem(&add(a, b), &self.n)
        }

        pub fn sub_mod(&self, a: &[u64], b: &[u64]) -> Nat {
            let a = self.fit(a);
            let b = self.fit(b);
            if cmp(&a, &b) == Ordering::Less {
                // a - b + n, computed as (a + n) - b so nothing goes negative.
                let mut t = add(&a, &self.n);
                sub_assign_wrapping(&mut t, &b);
                rem(&t, &self.n)
            } else {
                let mut t = a;
                sub_assign_wrapping(&mut t, &b);
                t
            }
        }

        /// base^exp mod n. NOT constant-time: `num-bigint`'s modpow is not
        /// either, and `srp` uses `num-bigint`, so this is no worse than the
        /// dependency we declined. The secret it guards is a setup code
        /// printed on a label, and the exponent lives for one pairing.
        pub fn pow_mod(&self, base: &[u64], exp: &[u64]) -> Nat {
            let b = self.fit(base);
            let bm = self.mont_mul(&b, &self.r2);
            let one = {
                let mut v = vec![0u64; self.len];
                v[0] = 1;
                v
            };
            let mut acc = self.mont_mul(&one, &self.r2);
            for i in (0..bits(exp)).rev() {
                acc = self.mont_mul(&acc, &acc);
                if bit(exp, i) {
                    acc = self.mont_mul(&acc, &bm);
                }
            }
            self.mont_mul(&acc, &one)
        }
    }
}

use bn::Nat;

// ===========================================================================
// Hash abstraction
// ===========================================================================

/// SRP is defined over "a hash", and the RFC 5054 Appendix B vector — the only
/// published vector that touches this arithmetic — is SHA-1 over the 1024-bit
/// group, while HAP is SHA-512 over the 3072-bit one. Being generic here is
/// what makes that vector usable at all; a SHA-512-only implementation could
/// not be checked against anything published.
pub trait SrpHash {
    const LEN: usize;
    fn digest(parts: &[&[u8]]) -> Vec<u8>;
}

pub struct Sha512Srp;

impl SrpHash for Sha512Srp {
    const LEN: usize = 64;
    fn digest(parts: &[&[u8]]) -> Vec<u8> {
        let mut h = Sha512::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().to_vec()
    }
}

// ===========================================================================
// Groups
// ===========================================================================

#[derive(Clone)]
pub struct Group {
    n: Vec<u8>,
    g: u8,
}

impl Group {
    pub fn n(&self) -> &[u8] {
        &self.n
    }
    pub fn g(&self) -> u8 {
        self.g
    }
    /// Width in bytes of N — and therefore of A, B, v and S. 384 for HAP.
    pub fn width(&self) -> usize {
        self.n.len()
    }
    /// PAD(g): the generator left-zero-padded to the full modulus width. Used
    /// by `k` and by nothing else — see the header's asymmetry #1 and #2.
    pub fn pad_g(&self) -> Vec<u8> {
        let mut v = vec![0u8; self.n.len()];
        v[self.n.len() - 1] = self.g;
        v
    }
}

/// RFC 5054 Appendix A §4, transcribed from the RFC text. The generator is 5.
/// `the_hap_group_is_the_rfc_5054_3072_bit_one` pins both the endpoints and a
/// SHA-256 of the whole thing, so a slip in the middle is caught too.
const HAP_N_HEX: &str = "\
    FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08\
    8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B\
    302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9\
    A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6\
    49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8\
    FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D\
    670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C\
    180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718\
    3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D\
    04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7D\
    B3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D226\
    1AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C\
    BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFC\
    E0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

/// The group HAP fixes: `SRP_get_default_gN("3072")`, HAPOpenSSL.c:136-141.
pub fn hap_group() -> Group {
    // `unhex` only ever sees the compiled-in constant above, never network
    // bytes, so a malformed literal is a build-time mistake caught by the
    // constant test — not something a peer can reach.
    Group { n: unhex(HAP_N_HEX).expect("HAP_N_HEX is a compiled-in constant"), g: 5 }
}

/// Whitespace-tolerant hex. Returns `None` rather than panicking so that no
/// caller can turn a bad string into an unwind.
pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let digits: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if digits.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(digits.len() / 2);
    for pair in digits.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

// ===========================================================================
// Errors
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SrpError {
    /// B was not exactly the modulus width after TLV reassembly.
    BadPublicKeyLength { got: usize, want: usize },
    /// RFC 5054 §2.5.4: abort if B mod N == 0. The mirror check on A is what
    /// HAPOpenSSL.c:238-250 does to us.
    PublicKeyZeroModN,
    /// u == 0 collapses the exponent and hands the session to anyone.
    ScramblingParameterZero,
}

impl std::fmt::Display for SrpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SrpError::BadPublicKeyLength { got, want } => {
                write!(f, "the accessory's SRP public key was {got} bytes, expected {want}")
            }
            SrpError::PublicKeyZeroModN => {
                write!(f, "the accessory's SRP public key is zero mod N — refusing to continue")
            }
            SrpError::ScramblingParameterZero => {
                write!(f, "the SRP scrambling parameter u is zero — refusing to continue")
            }
        }
    }
}

// ===========================================================================
// The hashed quantities
// ===========================================================================

/// x = H(salt ‖ H(user ‖ ":" ‖ pass)). Calc_x, HAPOpenSSL.c:115-134.
pub fn compute_x<H: SrpHash>(salt: &[u8], user: &[u8], pass: &[u8]) -> Vec<u8> {
    let inner = H::digest(&[user, b":", pass]);
    H::digest(&[salt, &inner])
}

/// k = H(PAD(N) ‖ PAD(g)). Both operands are the FULL modulus width — see
/// asymmetry #1. Calc_k, HAPOpenSSL.c:169-183.
pub fn compute_k<H: SrpHash>(group: &Group) -> Vec<u8> {
    H::digest(&[group.n(), &group.pad_g()])
}

/// u = H(PAD(A) ‖ PAD(B)). Both full width — asymmetry #3.
/// HAP_srp_scrambling_parameter, HAPOpenSSL.c:220-229.
pub fn compute_u<H: SrpHash>(a_pub: &[u8], b_pub: &[u8]) -> Vec<u8> {
    H::digest(&[a_pub, b_pub])
}

/// K = H(MIN(S)) — leading zero BYTES of the premaster secret are stripped
/// before hashing. Asymmetry #5. HAP_srp_session_key, HAPOpenSSL.c:275-278.
pub fn session_key<H: SrpHash>(premaster: &[u8]) -> Vec<u8> {
    H::digest(&[minimal(premaster)])
}

/// MIN(): big-endian with leading zero bytes removed, which is what OpenSSL's
/// `BN_bn2bin` yields and what `Count_Leading_Zeroes` reproduces by hand.
fn minimal(v: &[u8]) -> &[u8] {
    let z = v.iter().take_while(|b| **b == 0).count();
    &v[z..]
}

/// M1 = H( (H(PAD(N)) XOR H(MIN(g))) ‖ H(I) ‖ s ‖ MIN(A) ‖ MIN(B) ‖ K ).
///
/// Note the two disagreements with everything above, both deliberate and both
/// verified in HAP_srp_proof_m1 (HAPOpenSSL.c:286-320): the generator is
/// hashed as ONE byte here (asymmetry #2, `uint8_t g[1]`), and A and B are
/// MIN() rather than PAD() (asymmetry #4, via `Count_Leading_Zeroes`).
pub fn proof_m1<H: SrpHash>(
    group: &Group,
    user: &[u8],
    salt: &[u8],
    a_pub: &[u8],
    b_pub: &[u8],
    k_session: &[u8],
) -> Vec<u8> {
    let h_n = H::digest(&[group.n()]);
    let h_g = H::digest(&[&[group.g()][..]]);
    let h_ng: Vec<u8> = h_n.iter().zip(&h_g).map(|(a, b)| a ^ b).collect();
    let h_u = H::digest(&[user]);
    H::digest(&[&h_ng, &h_u, salt, minimal(a_pub), minimal(b_pub), k_session])
}

/// M2 = H(PAD(A) ‖ M1 ‖ K). A is the FULL 384-byte buffer here, unlike in M1.
/// HAP_srp_proof_m2, HAPOpenSSL.c:322-333.
///
/// The controller MUST check this. Skipping it throws away the accessory's
/// proof that it knows the setup code, which is the only reason to run SRP.
pub fn proof_m2<H: SrpHash>(a_pub: &[u8], m1: &[u8], k_session: &[u8]) -> Vec<u8> {
    H::digest(&[a_pub, m1, k_session])
}

// ===========================================================================
// The group arithmetic
// ===========================================================================

pub struct Srp {
    group: Group,
    mont: bn::Mont,
}

impl Srp {
    /// `None` only for an even modulus, which no SRP group has.
    pub fn new(group: Group) -> Option<Srp> {
        let mont = bn::Mont::new(group.n())?;
        Some(Srp { group, mont })
    }

    pub fn group(&self) -> &Group {
        &self.group
    }

    fn g_nat(&self) -> Nat {
        bn::from_be(&[self.group.g()])
    }

    /// PAD(): big-endian, left-zero-padded to the modulus width.
    ///
    /// Every value reaching here has been reduced mod N and N is exactly
    /// `width` bytes, so `to_be` cannot overflow — the fallback exists only so
    /// this crate has no unwrap on an arithmetic path. If it ever did fire it
    /// would emit an all-zero A, which an accessory rejects outright
    /// (`A mod N == 0`, HAPOpenSSL.c:238-250) rather than accepting quietly.
    fn pad(&self, x: &[u64]) -> Vec<u8> {
        bn::to_be(x, self.group.width()).unwrap_or_else(|| vec![0u8; self.group.width()])
    }

    /// A = PAD(g^a mod N). `a` is the client's secret, 32 random bytes — the
    /// wire format says nothing about its length (only A travels), and
    /// RFC 5054 §2.5.4 asks for at least 256 bits.
    pub fn public_a(&self, a: &[u8]) -> Vec<u8> {
        let a = bn::from_be(a);
        self.pad(&self.mont.pow_mod(&self.g_nat(), &a))
    }

    /// S = (B - k·g^x)^(a + u·x) mod N — RFC 5054 §2.6, client form.
    ///
    /// Returned PAD()ed to the modulus width, because `session_key` strips the
    /// leading zeros itself and the two steps must not both try.
    pub fn premaster_client(
        &self,
        a: &[u8],
        b_pub: &[u8],
        x: &[u8],
        u: &[u8],
        k: &[u8],
    ) -> Result<Vec<u8>, SrpError> {
        let want = self.group.width();
        if b_pub.len() != want {
            return Err(SrpError::BadPublicKeyLength { got: b_pub.len(), want });
        }
        let b_nat = bn::from_be(b_pub);
        let b_red = bn::rem(&b_nat, self.mont.modulus());
        if bn::is_zero(&b_red) {
            return Err(SrpError::PublicKeyZeroModN);
        }
        let u_nat = bn::from_be(u);
        if bn::is_zero(&u_nat) {
            return Err(SrpError::ScramblingParameterZero);
        }

        let x_nat = bn::from_be(x);
        let k_nat = bn::from_be(k);
        let gx = self.mont.pow_mod(&self.g_nat(), &x_nat);
        let kgx = self.mont.mul_mod(&k_nat, &gx);
        let base = self.mont.sub_mod(&b_red, &kgx);
        // The exponent is a PLAIN integer sum — no reduction mod N-1, which
        // would be wrong for a group whose order we do not use.
        let exp = bn::add(&a_to_nat(a), &bn::mul(&u_nat, &x_nat));
        Ok(self.pad(&self.mont.pow_mod(&base, &exp)))
    }

    /// v = g^x mod N. The accessory computes this at setup-code-generation
    /// time; we need it only to build a loopback accessory in tests and to
    /// check the RFC 5054 vector, which publishes v.
    pub fn verifier(&self, x: &[u8]) -> Vec<u8> {
        let x = bn::from_be(x);
        self.pad(&self.mont.pow_mod(&self.g_nat(), &x))
    }

    /// B = (k·v + g^b) mod N — the ACCESSORY's half. Calc_B, HAPOpenSSL.c:184.
    /// Present so the loopback test can be an accessory rather than a mirror
    /// of the controller; it is never called on the pairing path.
    pub fn public_b(&self, b: &[u8], v: &[u8], k: &[u8]) -> Vec<u8> {
        let gb = self.mont.pow_mod(&self.g_nat(), &bn::from_be(b));
        let kv = self.mont.mul_mod(&bn::from_be(k), &bn::from_be(v));
        self.pad(&self.mont.add_mod(&gb, &kv))
    }

    /// S = (A · v^u)^b mod N — the ACCESSORY's premaster secret,
    /// `SRP_Calc_server_key` as HAPOpenSSL.c:258 uses it.
    pub fn premaster_server(&self, a_pub: &[u8], b: &[u8], u: &[u8], v: &[u8]) -> Vec<u8> {
        let vu = self.mont.pow_mod(&bn::from_be(v), &bn::from_be(u));
        let base = self.mont.mul_mod(&bn::from_be(a_pub), &vu);
        self.pad(&self.mont.pow_mod(&base, &bn::from_be(b)))
    }
}

fn a_to_nat(a: &[u8]) -> Nat {
    bn::from_be(a)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Sha256;

    // -- a test-only SHA-1, because RFC 5054's vector is SHA-1 -------------
    //
    // There is no `sha1` crate in this manifest's direct dependencies and
    // Cargo.toml is not this agent's file. Without SHA-1 the ONLY published
    // vector that exercises this arithmetic is unusable, so it is implemented
    // here, in test code, and checked against the FIPS 180-1 sample hashes
    // before anything else relies on it.
    struct Sha1Srp;

    fn sha1(data: &[u8]) -> [u8; 20] {
        let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
        let mut msg = data.to_vec();
        let bitlen = (data.len() as u64) * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bitlen.to_be_bytes());
        for block in msg.chunks(64) {
            let mut w = [0u32; 80];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([
                    block[4 * i],
                    block[4 * i + 1],
                    block[4 * i + 2],
                    block[4 * i + 3],
                ]);
            }
            for i in 16..80 {
                w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
            }
            let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
            for (i, wi) in w.iter().enumerate() {
                let (f, k) = match i {
                    0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                    20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                    40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                    _ => (b ^ c ^ d, 0xCA62C1D6),
                };
                let t = a
                    .rotate_left(5)
                    .wrapping_add(f)
                    .wrapping_add(e)
                    .wrapping_add(k)
                    .wrapping_add(*wi);
                e = d;
                d = c;
                c = b.rotate_left(30);
                b = a;
                a = t;
            }
            h[0] = h[0].wrapping_add(a);
            h[1] = h[1].wrapping_add(b);
            h[2] = h[2].wrapping_add(c);
            h[3] = h[3].wrapping_add(d);
            h[4] = h[4].wrapping_add(e);
        }
        let mut out = [0u8; 20];
        for i in 0..5 {
            out[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes());
        }
        out
    }

    impl SrpHash for Sha1Srp {
        const LEN: usize = 20;
        fn digest(parts: &[&[u8]]) -> Vec<u8> {
            let mut buf = Vec::new();
            for p in parts {
                buf.extend_from_slice(p);
            }
            sha1(&buf).to_vec()
        }
    }

    fn hx(s: &str) -> Vec<u8> {
        unhex(s).expect("test hex")
    }

    /// FIPS 180-1 Appendix A/B. If this fails, the RFC 5054 vector below
    /// proves nothing, so it runs first in spirit.
    #[test]
    fn the_test_only_sha1_matches_the_fips_180_1_samples() {
        assert_eq!(hx("A9993E364706816ABA3E25717850C26C9CD0D89D"), sha1(b"abc").to_vec());
        assert_eq!(
            hx("84983E441C3BD26EBAAE4AA1F95129E5E54670F1"),
            sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq").to_vec()
        );
        assert_eq!(hx("DA39A3EE5E6B4B0D3255BFEF95601890AFD80709"), sha1(b"").to_vec());
    }

    // -- the bignum, against an independent oracle -------------------------

    fn xorshift(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }

    /// The Montgomery path is the one that is easy to get subtly wrong, so it
    /// is never trusted alone: this runs it against `bn::rem`-based schoolbook
    /// modular multiplication, which is slow but has no clever steps in it.
    #[test]
    fn montgomery_multiplication_agrees_with_schoolbook_division() {
        let mut st = 0x9E37_79B9_7F4A_7C15u64;
        for n_bytes in [16usize, 33, 64, 128] {
            // A random ODD modulus of the right width, top bit set.
            let mut n = vec![0u8; n_bytes];
            for b in n.iter_mut() {
                *b = (xorshift(&mut st) & 0xFF) as u8;
            }
            n[0] |= 0x80;
            n[n_bytes - 1] |= 1;
            let m = bn::Mont::new(&n).expect("odd modulus");
            let n_nat = bn::from_be(&n);
            for _ in 0..40 {
                let mut a = vec![0u8; n_bytes];
                let mut b = vec![0u8; n_bytes];
                for i in 0..n_bytes {
                    a[i] = (xorshift(&mut st) & 0xFF) as u8;
                    b[i] = (xorshift(&mut st) & 0xFF) as u8;
                }
                let an = bn::from_be(&a);
                let bnat = bn::from_be(&b);
                let fast = m.mul_mod(&an, &bnat);
                let slow = bn::rem(&bn::mul(&bn::rem(&an, &n_nat), &bn::rem(&bnat, &n_nat)), &n_nat);
                assert_eq!(bn::cmp(&fast, &slow), std::cmp::Ordering::Equal, "n_bytes={n_bytes}");
            }
        }
    }

    /// modpow against a schoolbook square-and-multiply that uses only `rem`.
    #[test]
    fn montgomery_modpow_agrees_with_a_division_only_reference() {
        let mut st = 0x1234_5678_9ABC_DEF0u64;
        let mut n = vec![0u8; 32];
        for b in n.iter_mut() {
            *b = (xorshift(&mut st) & 0xFF) as u8;
        }
        n[0] |= 0x80;
        n[31] |= 1;
        let m = bn::Mont::new(&n).unwrap();
        let n_nat = bn::from_be(&n);
        for _ in 0..8 {
            let mut base = vec![0u8; 32];
            let mut e = vec![0u8; 8];
            for b in base.iter_mut() {
                *b = (xorshift(&mut st) & 0xFF) as u8;
            }
            for b in e.iter_mut() {
                *b = (xorshift(&mut st) & 0xFF) as u8;
            }
            let base_n = bn::rem(&bn::from_be(&base), &n_nat);
            let exp = bn::from_be(&e);
            let fast = m.pow_mod(&base_n, &exp);

            let mut acc = vec![1u64];
            for i in (0..bn::bits(&exp)).rev() {
                acc = bn::rem(&bn::mul(&acc, &acc), &n_nat);
                if bn::bit(&exp, i) {
                    acc = bn::rem(&bn::mul(&acc, &base_n), &n_nat);
                }
            }
            assert_eq!(bn::cmp(&fast, &acc), std::cmp::Ordering::Equal);
        }
    }

    #[test]
    fn small_modpow_values_are_the_ones_you_can_check_by_hand() {
        let m = bn::Mont::new(&[7]).unwrap();
        // 3^5 = 243 = 34*7 + 5
        assert_eq!(m.pow_mod(&bn::from_be(&[3]), &bn::from_be(&[5]))[0], 5);
        // anything^0 == 1
        assert_eq!(m.pow_mod(&bn::from_be(&[5]), &bn::from_be(&[0]))[0], 1);
        // 2^10 = 1024 = 146*7 + 2
        assert_eq!(m.pow_mod(&bn::from_be(&[2]), &bn::from_be(&[10]))[0], 2);
    }

    // -- LAYER 1: the published vector -------------------------------------

    fn rfc5054_1024() -> Group {
        Group {
            n: hx("\
                EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C\
                9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE4\
                8E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B29\
                7BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9A\
                FD5138FE8376435B9FC61D2FC0EB06E3"),
            g: 2,
        }
    }

    /// RFC 5054 Appendix B, verbatim from https://www.rfc-editor.org/rfc/rfc5054.txt
    /// (lines 1126-1201 of the text file). SHA-1 over the 1024-bit group —
    /// NOT HAP's parameters — which is exactly its value: it validates x, k, v,
    /// A, B, u and S independently of the hash and the group, and it is the
    /// only published vector in existence that touches this arithmetic.
    ///
    /// WHAT IT DOES NOT COVER, and nothing else does either: M1, M2,
    /// K = H(MIN(S)), SHA-512, the 3072-bit group, and every PAD/MIN asymmetry
    /// in this file's header. RFC 5054 stops at the premaster secret because
    /// TLS derives its own finished messages.
    #[test]
    fn rfc_5054_appendix_b_vector_reproduces_x_k_v_a_b_u_and_the_premaster_secret() {
        let group = rfc5054_1024();
        let srp = Srp::new(group.clone()).unwrap();
        let salt = hx("BEB25379D1A8581EB5A727673A2441EE");

        let x = compute_x::<Sha1Srp>(&salt, b"alice", b"password123");
        assert_eq!(x, hx("94B7555AABE9127CC58CCF4993DB6CF84D16C124"), "x");

        let k = compute_k::<Sha1Srp>(&group);
        assert_eq!(k, hx("7556AA045AEF2CDD07ABAF0F665C3E818913186F"), "k");

        let v = srp.verifier(&x);
        assert_eq!(
            v,
            hx("\
                7E273DE8696FFC4F4E337D05B4B375BEB0DDE1569E8FA00A9886D812\
                9BADA1F1822223CA1A605B530E379BA4729FDC59F105B4787E5186F5\
                C671085A1447B52A48CF1970B4FB6F8400BBF4CEBFBB168152E08AB5\
                EA53D15C1AFF87B2B9DA6E04E058AD51CC72BFC9033B564E26480D78\
                E955A5E29E7AB245DB2BE315E2099AFB"),
            "v"
        );

        let a = hx("60975527035CF2AD1989806F0407210BC81EDC04E2762A56AFD529DDDA2D4393");
        let b = hx("E487CB59D31AC550471E81F00F6928E01DDA08E974A004F49E61F5D105284D20");

        let a_pub = srp.public_a(&a);
        assert_eq!(
            a_pub,
            hx("\
                61D5E490F6F1B79547B0704C436F523DD0E560F0C64115BB72557EC4\
                4352E8903211C04692272D8B2D1A5358A2CF1B6E0BFCF99F921530EC\
                8E39356179EAE45E42BA92AEACED825171E1E8B9AF6D9C03E1327F44\
                BE087EF06530E69F66615261EEF54073CA11CF5858F0EDFDFE15EFEA\
                B349EF5D76988A3672FAC47B0769447B"),
            "A"
        );

        let b_pub = srp.public_b(&b, &v, &k);
        assert_eq!(
            b_pub,
            hx("\
                BD0C61512C692C0CB6D041FA01BB152D4916A1E77AF46AE105393011\
                BAF38964DC46A0670DD125B95A981652236F99D9B681CBF87837EC99\
                6C6DA04453728610D0C6DDB58B318885D7D82C7F8DEB75CE7BD4FBAA\
                37089E6F9C6059F388838E7A00030B331EB76840910440B1B27AAEAE\
                EB4012B7D7665238A8E3FB004B117B58"),
            "B"
        );

        let u = compute_u::<Sha1Srp>(&a_pub, &b_pub);
        assert_eq!(u, hx("CE38B9593487DA98554ED47D70A7AE5F462EF019"), "u");

        let expected_s = hx("\
            B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D\
            233861E359B48220F7C4693C9AE12B0A6F67809F0876E2D013800D6C\
            41BB59B6D5979B5C00A172B4A2A5903A0BDCAF8A709585EB2AFAFA8F\
            3499B200210DCC1F10EB33943CD67FC88A2F39A4BE5BEC4EC0A3212D\
            C346D7E474B29EDE8A469FFECA686E5A");

        // The CLIENT form: (B - k·g^x)^(a + u·x).
        let s_client = srp.premaster_client(&a, &b_pub, &x, &u, &k).unwrap();
        assert_eq!(s_client, expected_s, "client premaster secret");

        // …and the SERVER form, (A · v^u)^b, must land on the same number.
        // Both are in the vector's scope, and agreeing is what proves the
        // client branch is the client branch and not an accidental copy.
        let s_server = srp.premaster_server(&a_pub, &b, &u, &v);
        assert_eq!(s_server, expected_s, "server premaster secret");
    }

    // -- LAYER 2: the constants nothing can verify for us ------------------

    /// The group HAP fixes. Endpoints AND a digest of the whole thing, so a
    /// transcription slip in the middle 380 bytes cannot slip through.
    #[test]
    fn the_hap_group_is_the_rfc_5054_3072_bit_one() {
        let g = hap_group();
        assert_eq!(g.width(), 384);
        assert_eq!(g.g(), 5);
        assert_eq!(&g.n()[0..8], &[0xFF; 8]);
        assert_eq!(&g.n()[376..384], &[0xFF; 8]);
        // SHA-256 of the 384-byte modulus, computed from THIS constant. It
        // pins the bytes against future edits; it does not prove they are
        // Apple's — that comes from RFC 5054 Appendix A §4, transcribed above.
        let mut h = Sha256::new();
        h.update(g.n());
        // Regenerate with:
        //   sed -n '/3072-bit Group/,/generator is: 5/p' rfc5054.txt \
        //     | tr -dc '0-9A-F' | xxd -r -p | shasum -a 256
        assert_eq!(
            h.finalize().to_vec(),
            hx("48cf8b092fbce4359d9871abf74f98e25b6163379eaa15cd9087e800c6d1c55c"),
            "the 3072-bit modulus changed"
        );
    }

    /// PAD(g) is 383 zero bytes then 0x05 — asymmetry #1. If this ever became
    /// a one-byte buffer, `k` changes and every pairing fails with a proof
    /// mismatch that looks like a wrong setup code.
    #[test]
    fn pad_g_is_the_full_modulus_width_but_m1_hashes_one_byte() {
        let g = hap_group();
        let padded = g.pad_g();
        assert_eq!(padded.len(), 384);
        assert_eq!(padded[383], 5);
        assert!(padded[..383].iter().all(|b| *b == 0));

        // …and M1's H(g) is over ONE byte. Demonstrated by showing that M1
        // changes if the padded form is substituted — i.e. these two really
        // are different inputs, which is the whole trap.
        let one = Sha512Srp::digest(&[&[5u8][..]]);
        let full = Sha512Srp::digest(&[&padded]);
        assert_ne!(one, full);
    }

    #[test]
    fn minimal_strips_leading_zeros_and_pad_restores_them() {
        assert_eq!(minimal(&[0, 0, 1, 2]), &[1u8, 2]);
        assert_eq!(minimal(&[1, 2]), &[1u8, 2]);
        assert_eq!(minimal(&[0, 0, 0]), &[] as &[u8]);
        // A premaster secret with a leading zero byte is the case that makes
        // an unpadded implementation fail one time in 256.
        let s = vec![0u8, 0xAB, 0xCD];
        assert_eq!(session_key::<Sha512Srp>(&s), Sha512Srp::digest(&[&[0xAB, 0xCD][..]]));
        assert_ne!(session_key::<Sha512Srp>(&s), Sha512Srp::digest(&[&s]));
    }

    // -- the compositions no published vector reaches ----------------------
    //
    // RFC 5054 Appendix B stops at the premaster secret, so `u`'s padding and
    // the whole of M1/M2 are unverifiable from any published source. Worse,
    // the Appendix B vector CANNOT discriminate `u`'s padding at all: its A
    // and B both happen to begin with a non-zero byte (61D5… and BD0C…), so
    // MIN and PAD coincide and a wrong implementation passes it.
    //
    // These three tests therefore do two things the vector cannot. They feed
    // operands that DO carry a leading zero byte, so PAD and MIN produce
    // genuinely different digests; and they rebuild the expected value from
    // the documented byte sequence by hand rather than by calling the function
    // under test. Each was confirmed to bite by mutation: swapping the
    // generator to PAD(g), swapping `u` to MIN, swapping M1's A/B to PAD and
    // swapping M2's A to MIN each turn exactly one of these red, and every one
    // of those four mutations passed the whole suite before they existed.
    //
    // HONEST LIMIT: this pins the code against future edits and against the
    // srp-0.6 defect. It does NOT prove the transcription from HAPOpenSSL.c is
    // right — only a live accessory does that, and none exists here.

    /// A 384-byte value whose first byte is zero, so MIN() is 383 bytes and
    /// PAD() is 384 — the case that separates the two.
    fn leading_zero_384(fill: u8) -> Vec<u8> {
        let mut v = vec![fill; 384];
        v[0] = 0;
        v
    }

    /// Asymmetry #3. This is the exact defect in `srp` 0.6's `compute_u`,
    /// which hashes `BigUint::to_bytes_be()` — i.e. MIN — while its own
    /// comment claims PAD. It fails only when a leading zero turns up, which
    /// is roughly 1 pairing in 128 and looks like flaky hardware.
    #[test]
    fn u_hashes_both_operands_at_full_width_not_stripped() {
        let a_pub = leading_zero_384(0x11);
        let b_pub = leading_zero_384(0x22);
        let got = compute_u::<Sha512Srp>(&a_pub, &b_pub);
        assert_eq!(got, Sha512Srp::digest(&[&a_pub, &b_pub]), "u must hash PAD(A) ‖ PAD(B)");
        assert_ne!(
            got,
            Sha512Srp::digest(&[minimal(&a_pub), minimal(&b_pub)]),
            "u must NOT hash MIN(A) ‖ MIN(B) — that is the srp-0.6 bug"
        );
    }

    /// Asymmetries #2 and #4 together, both inside M1 and both contradicting
    /// the padding used elsewhere in the very same file: the generator is
    /// hashed as ONE byte (`uint8_t g[1]`, HAPOpenSSL.c:311) while `k` pads it
    /// to 384, and A and B are STRIPPED here while `u` pads them.
    #[test]
    fn m1_hashes_one_byte_of_g_and_strips_a_and_b() {
        let group = hap_group();
        let user = b"Pair-Setup";
        let salt = [0xA5u8; 16];
        let a_pub = leading_zero_384(0x11);
        let b_pub = leading_zero_384(0x22);
        let k_session = vec![0x33u8; 64];

        // Built by hand from the documented sequence, not from proof_m1.
        let h_n = Sha512Srp::digest(&[group.n()]);
        let h_g_one = Sha512Srp::digest(&[&[5u8][..]]);
        let xor: Vec<u8> = h_n.iter().zip(&h_g_one).map(|(a, b)| a ^ b).collect();
        let expected = Sha512Srp::digest(&[
            &xor,
            &Sha512Srp::digest(&[user]),
            &salt,
            minimal(&a_pub),
            minimal(&b_pub),
            &k_session,
        ]);
        let got = proof_m1::<Sha512Srp>(&group, user, &salt, &a_pub, &b_pub, &k_session);
        assert_eq!(got, expected, "M1 composition drifted");

        // …and the two wrong variants really are different values, so the
        // assertion above is discriminating rather than vacuous.
        let h_g_padded = Sha512Srp::digest(&[&group.pad_g()]);
        let xor_padded: Vec<u8> = h_n.iter().zip(&h_g_padded).map(|(a, b)| a ^ b).collect();
        assert_ne!(
            got,
            Sha512Srp::digest(&[
                &xor_padded,
                &Sha512Srp::digest(&[user]),
                &salt,
                minimal(&a_pub),
                minimal(&b_pub),
                &k_session,
            ]),
            "M1 must hash the SINGLE byte 0x05, not PAD(g)"
        );
        assert_ne!(
            got,
            Sha512Srp::digest(&[
                &xor,
                &Sha512Srp::digest(&[user]),
                &salt,
                &a_pub,
                &b_pub,
                &k_session,
            ]),
            "M1 must hash MIN(A) ‖ MIN(B), not the padded forms"
        );
    }

    /// The reversal: M2 hashes A at FULL width again, having stripped it in
    /// M1 one function earlier. HAPOpenSSL.c:322-333.
    #[test]
    fn m2_hashes_a_at_full_width_having_stripped_it_in_m1() {
        let a_pub = leading_zero_384(0x11);
        let m1 = vec![0x44u8; 64];
        let k_session = vec![0x33u8; 64];
        let got = proof_m2::<Sha512Srp>(&a_pub, &m1, &k_session);
        assert_eq!(got, Sha512Srp::digest(&[&a_pub, &m1, &k_session]));
        assert_ne!(
            got,
            Sha512Srp::digest(&[minimal(&a_pub), &m1, &k_session]),
            "M2 must hash PAD(A), not MIN(A)"
        );
    }

    // -- refusals ----------------------------------------------------------

    #[test]
    fn a_b_that_is_zero_mod_n_is_refused_rather_than_used() {
        let srp = Srp::new(hap_group()).unwrap();
        let zero = vec![0u8; 384];
        assert_eq!(
            srp.premaster_client(&[1], &zero, &[1], &[1], &[1]),
            Err(SrpError::PublicKeyZeroModN)
        );
        // B == N is also 0 mod N, and is the case a naive `is_zero` misses.
        let n = hap_group().n().to_vec();
        assert_eq!(
            srp.premaster_client(&[1], &n, &[1], &[1], &[1]),
            Err(SrpError::PublicKeyZeroModN)
        );
    }

    #[test]
    fn a_b_of_the_wrong_length_is_refused_before_any_arithmetic() {
        let srp = Srp::new(hap_group()).unwrap();
        assert_eq!(
            srp.premaster_client(&[1], &[0u8; 32], &[1], &[1], &[1]),
            Err(SrpError::BadPublicKeyLength { got: 32, want: 384 })
        );
    }

    #[test]
    fn a_zero_scrambling_parameter_is_refused() {
        let srp = Srp::new(hap_group()).unwrap();
        let mut b = vec![0u8; 384];
        b[383] = 7;
        assert_eq!(
            srp.premaster_client(&[1], &b, &[1], &[0u8; 64], &[1]),
            Err(SrpError::ScramblingParameterZero)
        );
    }

    /// The HAP parameters end to end, at full 3072-bit width, with SHA-512 —
    /// client and accessory agreeing on S and on K.
    ///
    /// READ THIS BEFORE TRUSTING IT: this proves internal consistency ONLY.
    /// It would pass identically if `compute_k` hashed the wrong thing, since
    /// both sides call the same `compute_k`. What it does prove is that the
    /// client branch and the server branch of the arithmetic — which are
    /// genuinely different formulas — meet, at the width and hash HAP uses.
    #[test]
    fn the_hap_group_and_sha512_reach_a_shared_secret_at_full_width() {
        let group = hap_group();
        let srp = Srp::new(group.clone()).unwrap();
        let salt = vec![0x11u8; 16];
        let user = b"Pair-Setup";
        let pass = b"123-45-678";

        let x = compute_x::<Sha512Srp>(&salt, user, pass);
        let k = compute_k::<Sha512Srp>(&group);
        let v = srp.verifier(&x);

        let a = vec![0x42u8; 32];
        let b = vec![0x24u8; 32];
        let a_pub = srp.public_a(&a);
        let b_pub = srp.public_b(&b, &v, &k);
        assert_eq!(a_pub.len(), 384);
        assert_eq!(b_pub.len(), 384);

        let u = compute_u::<Sha512Srp>(&a_pub, &b_pub);
        let s_c = srp.premaster_client(&a, &b_pub, &x, &u, &k).unwrap();
        let s_s = srp.premaster_server(&a_pub, &b, &u, &v);
        assert_eq!(s_c, s_s, "client and accessory disagree on S");

        let kc = session_key::<Sha512Srp>(&s_c);
        assert_eq!(kc.len(), 64);
        let m1 = proof_m1::<Sha512Srp>(&group, user, &salt, &a_pub, &b_pub, &kc);
        assert_eq!(m1.len(), 64);
        let m2 = proof_m2::<Sha512Srp>(&a_pub, &m1, &kc);
        assert_eq!(m2.len(), 64);
    }
}
