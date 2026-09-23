//! Browser -> privileged-service input protocol for the Windows native desktop.
//!
//! Browser input is a separate, fixed-size protocol from worker control frames.
//! It carries only a stream epoch, monotonic input sequence and a finite typed
//! event. GPU identifiers, WTS identifiers, media capabilities and arbitrary
//! commands never enter browser-visible/input messages.

use crate::worker_protocol::{WorkerInputEvent, WorkerMouseButton};

pub const BROWSER_INPUT_PROTOCOL_VERSION: u16 = 1;
pub const BROWSER_INPUT_FRAME_SIZE: usize = 32;

const MAGIC: &[u8; 4] = b"GBNI";
const KIND_KEY: u8 = 1;
const KIND_MOUSE_RELATIVE: u8 = 2;
const KIND_MOUSE_ABSOLUTE: u8 = 3;
const KIND_MOUSE_BUTTON: u8 = 4;
const KIND_MOUSE_WHEEL: u8 = 5;
const FLAG_KEY_UP: u8 = 0x01;
const FLAG_EXTENDED: u8 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserInputError {
    InvalidLength,
    Magic,
    ProtocolVersion,
    Kind,
    Flags,
    StreamEpoch,
    Sequence,
    Event,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserInputFrame {
    pub stream_epoch: u64,
    pub sequence: u64,
    pub event: WorkerInputEvent,
}

fn read_i32(frame: &[u8], offset: usize) -> Result<i32, BrowserInputError> {
    let bytes: [u8; 4] = frame
        .get(offset..offset + 4)
        .ok_or(BrowserInputError::InvalidLength)?
        .try_into()
        .map_err(|_| BrowserInputError::InvalidLength)?;
    Ok(i32::from_le_bytes(bytes))
}

fn read_u64(frame: &[u8], offset: usize) -> Result<u64, BrowserInputError> {
    let bytes: [u8; 8] = frame
        .get(offset..offset + 8)
        .ok_or(BrowserInputError::InvalidLength)?
        .try_into()
        .map_err(|_| BrowserInputError::InvalidLength)?;
    Ok(u64::from_le_bytes(bytes))
}

fn button(value: i32) -> Result<WorkerMouseButton, BrowserInputError> {
    match value {
        1 => Ok(WorkerMouseButton::Left),
        2 => Ok(WorkerMouseButton::Right),
        3 => Ok(WorkerMouseButton::Middle),
        4 => Ok(WorkerMouseButton::X1),
        5 => Ok(WorkerMouseButton::X2),
        _ => Err(BrowserInputError::Event),
    }
}

pub fn decode_browser_input(frame: &[u8]) -> Result<BrowserInputFrame, BrowserInputError> {
    if frame.len() != BROWSER_INPUT_FRAME_SIZE {
        return Err(BrowserInputError::InvalidLength);
    }
    if frame.get(0..4) != Some(MAGIC.as_slice()) {
        return Err(BrowserInputError::Magic);
    }
    if u16::from_le_bytes([frame[4], frame[5]]) != BROWSER_INPUT_PROTOCOL_VERSION {
        return Err(BrowserInputError::ProtocolVersion);
    }

    let kind = frame[6];
    let flags = frame[7];
    let stream_epoch = read_u64(frame, 8)?;
    let sequence = read_u64(frame, 16)?;
    if stream_epoch == 0 {
        return Err(BrowserInputError::StreamEpoch);
    }
    if sequence == 0 {
        return Err(BrowserInputError::Sequence);
    }

    let arg1 = read_i32(frame, 24)?;
    let arg2 = read_i32(frame, 28)?;
    let event = match kind {
        KIND_KEY => {
            if flags & !(FLAG_KEY_UP | FLAG_EXTENDED) != 0
                || arg2 != 0
                || !(1..=0x01ff).contains(&arg1)
            {
                return Err(BrowserInputError::Event);
            }
            WorkerInputEvent::KeyScan {
                scan_code: arg1 as u16,
                key_up: flags & FLAG_KEY_UP != 0,
                extended: flags & FLAG_EXTENDED != 0,
            }
        }
        KIND_MOUSE_RELATIVE => {
            if flags != 0
                || (arg1 == 0 && arg2 == 0)
                || !(-32_767..=32_767).contains(&arg1)
                || !(-32_767..=32_767).contains(&arg2)
            {
                return Err(BrowserInputError::Event);
            }
            WorkerInputEvent::MouseMoveRelative {
                dx: arg1,
                dy: arg2,
            }
        }
        KIND_MOUSE_ABSOLUTE => {
            if flags != 0
                || !(0..=u16::MAX as i32).contains(&arg1)
                || !(0..=u16::MAX as i32).contains(&arg2)
            {
                return Err(BrowserInputError::Event);
            }
            WorkerInputEvent::MouseMoveAbsolute {
                x: arg1 as u16,
                y: arg2 as u16,
            }
        }
        KIND_MOUSE_BUTTON => {
            if flags & !FLAG_KEY_UP != 0 || arg2 != 0 {
                return Err(BrowserInputError::Event);
            }
            WorkerInputEvent::MouseButton {
                button: button(arg1)?,
                key_up: flags & FLAG_KEY_UP != 0,
            }
        }
        KIND_MOUSE_WHEEL => {
            if flags != 0 || arg2 != 0 || arg1 == 0 || !(-1_200..=1_200).contains(&arg1) {
                return Err(BrowserInputError::Event);
            }
            WorkerInputEvent::MouseWheel {
                delta: arg1 as i16,
            }
        }
        _ => return Err(BrowserInputError::Kind),
    };

    Ok(BrowserInputFrame {
        stream_epoch,
        sequence,
        event,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserInputFence {
    stream_epoch: u64,
    next_sequence: u64,
}

impl BrowserInputFence {
    pub fn new(stream_epoch: u64) -> Result<Self, BrowserInputError> {
        if stream_epoch == 0 {
            return Err(BrowserInputError::StreamEpoch);
        }
        Ok(Self {
            stream_epoch,
            next_sequence: 1,
        })
    }

    pub fn accept(&mut self, frame: &[u8]) -> Result<WorkerInputEvent, BrowserInputError> {
        let decoded = decode_browser_input(frame)?;
        if decoded.stream_epoch != self.stream_epoch {
            return Err(BrowserInputError::StreamEpoch);
        }
        if decoded.sequence != self.next_sequence {
            return Err(BrowserInputError::Sequence);
        }
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(BrowserInputError::Sequence)?;
        Ok(decoded.event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(kind: u8, flags: u8, epoch: u64, sequence: u64, arg1: i32, arg2: i32) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[0..4].copy_from_slice(MAGIC);
        out[4..6].copy_from_slice(&BROWSER_INPUT_PROTOCOL_VERSION.to_le_bytes());
        out[6] = kind;
        out[7] = flags;
        out[8..16].copy_from_slice(&epoch.to_le_bytes());
        out[16..24].copy_from_slice(&sequence.to_le_bytes());
        out[24..28].copy_from_slice(&arg1.to_le_bytes());
        out[28..32].copy_from_slice(&arg2.to_le_bytes());
        out
    }

    #[test]
    fn key_and_mouse_frames_decode_to_the_existing_worker_event_types() {
        assert_eq!(
            decode_browser_input(&packet(KIND_KEY, FLAG_EXTENDED, 7, 1, 0x1d, 0)),
            Ok(BrowserInputFrame {
                stream_epoch: 7,
                sequence: 1,
                event: WorkerInputEvent::KeyScan {
                    scan_code: 0x1d,
                    key_up: false,
                    extended: true,
                },
            })
        );
        assert_eq!(
            decode_browser_input(&packet(KIND_MOUSE_RELATIVE, 0, 7, 2, 5, -3)),
            Ok(BrowserInputFrame {
                stream_epoch: 7,
                sequence: 2,
                event: WorkerInputEvent::MouseMoveRelative { dx: 5, dy: -3 },
            })
        );
        assert_eq!(
            decode_browser_input(&packet(KIND_MOUSE_ABSOLUTE, 0, 7, 3, 65_535, 0)),
            Ok(BrowserInputFrame {
                stream_epoch: 7,
                sequence: 3,
                event: WorkerInputEvent::MouseMoveAbsolute { x: 65_535, y: 0 },
            })
        );
    }

    #[test]
    fn malformed_values_fail_closed_before_worker_control() {
        let mut invalid_magic = packet(KIND_KEY, 0, 1, 1, 0x1e, 0);
        invalid_magic[0] = b'X';
        assert_eq!(decode_browser_input(&invalid_magic), Err(BrowserInputError::Magic));
        assert_eq!(
            decode_browser_input(&packet(KIND_KEY, 0x80, 1, 1, 0x1e, 0)),
            Err(BrowserInputError::Event)
        );
        assert_eq!(
            decode_browser_input(&packet(KIND_MOUSE_RELATIVE, 0, 1, 1, 0, 0)),
            Err(BrowserInputError::Event)
        );
        assert_eq!(
            decode_browser_input(&packet(KIND_MOUSE_WHEEL, 0, 1, 1, 1_201, 0)),
            Err(BrowserInputError::Event)
        );
        assert_eq!(
            decode_browser_input(&packet(99, 0, 1, 1, 0, 0)),
            Err(BrowserInputError::Kind)
        );
    }

    #[test]
    fn stream_epoch_and_sequence_replay_are_fenced() {
        let mut fence = BrowserInputFence::new(9).expect("fence");
        let first = packet(KIND_MOUSE_BUTTON, 0, 9, 1, 1, 0);
        assert_eq!(
            fence.accept(&first),
            Ok(WorkerInputEvent::MouseButton {
                button: WorkerMouseButton::Left,
                key_up: false,
            })
        );
        assert_eq!(fence.accept(&first), Err(BrowserInputError::Sequence));
        assert_eq!(
            fence.accept(&packet(KIND_MOUSE_BUTTON, 0, 8, 2, 1, 0)),
            Err(BrowserInputError::StreamEpoch)
        );
        assert_eq!(
            fence.accept(&packet(KIND_MOUSE_BUTTON, FLAG_KEY_UP, 9, 2, 1, 0)),
            Ok(WorkerInputEvent::MouseButton {
                button: WorkerMouseButton::Left,
                key_up: true,
            })
        );
    }
}
