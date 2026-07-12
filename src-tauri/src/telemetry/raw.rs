//! Bounds-checked little-endian readers. Every accessor returns `Option`, so a
//! short/truncated datagram bails via `?` instead of panicking the UDP thread.

#[inline]
pub fn u8_at(b: &[u8], o: usize) -> Option<u8> {
    b.get(o).copied()
}

#[inline]
pub fn i8_at(b: &[u8], o: usize) -> Option<i8> {
    b.get(o).map(|&v| v as i8)
}

#[inline]
pub fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}

#[inline]
pub fn i16_at(b: &[u8], o: usize) -> Option<i16> {
    Some(i16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}

#[inline]
pub fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}

#[inline]
pub fn u64_at(b: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
}

#[inline]
pub fn f32_at(b: &[u8], o: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
