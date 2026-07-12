//! The 29-byte F1 UDP packet header (format 2025/2026 — identical shape).
//! Ported from `bridge/f1-2026-parser.cjs` headerParser.

use super::raw::{u16_at, u32_at, u64_at, u8_at};

pub const HEADER_LEN: usize = 29;

#[derive(Clone, Copy)]
pub struct Header {
    pub packet_format: u16,
    pub packet_id: u8,
    pub session_uid: u64,
    pub overall_frame_identifier: u32,
    pub player_car_index: u8,
}

impl Header {
    /// Parse just the fields the core needs. Returns `None` if the buffer is
    /// shorter than the header.
    pub fn parse(buf: &[u8]) -> Option<Header> {
        if buf.len() < HEADER_LEN {
            return None;
        }
        Some(Header {
            packet_format: u16_at(buf, 0)?,
            packet_id: u8_at(buf, 6)?,
            session_uid: u64_at(buf, 7)?,
            overall_frame_identifier: u32_at(buf, 23)?,
            player_car_index: u8_at(buf, 27)?,
        })
    }

    pub fn is_supported(&self) -> bool {
        self.packet_format == 2025 || self.packet_format == 2026
    }

    /// Cars in a per-car array for this format. 2026 added grid slots (24);
    /// 2025 and earlier are 22. Mirrors the C++ `maxCarsFor`.
    pub fn max_cars(&self) -> usize {
        if self.packet_format == 2026 {
            24
        } else {
            22
        }
    }
}
