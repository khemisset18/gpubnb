//! Typed renter-session input injection.
//!
//! The privileged service never calls SendInput. Only the dedicated renter worker
//! may invoke this API, and every call is fenced to the worker's current WTS
//! session. The surface deliberately exposes a finite set of keyboard/mouse events
//! rather than arbitrary window messages or shell commands.

use crate::session::current_process_session_id;
use crate::PlatformError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEvent {
    KeyScan {
        scan_code: u16,
        key_up: bool,
        extended: bool,
    },
    MouseMoveRelative {
        dx: i32,
        dy: i32,
    },
    MouseMoveAbsolute {
        x: u16,
        y: u16,
    },
    MouseButton {
        button: MouseButton,
        key_up: bool,
    },
    MouseWheel {
        delta: i16,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputError {
    WindowsRequired,
    WrongSession,
    InvalidEvent,
    InjectionFailed,
}

fn validate_event(event: InputEvent) -> Result<(), InputError> {
    match event {
        InputEvent::KeyScan { scan_code, .. } => {
            if scan_code == 0 || scan_code > 0x01ff {
                return Err(InputError::InvalidEvent);
            }
        }
        InputEvent::MouseMoveRelative { dx, dy } => {
            if dx == 0 && dy == 0 {
                return Err(InputError::InvalidEvent);
            }
            if !(-32_767..=32_767).contains(&dx) || !(-32_767..=32_767).contains(&dy) {
                return Err(InputError::InvalidEvent);
            }
        }
        InputEvent::MouseMoveAbsolute { .. } => {}
        InputEvent::MouseButton { .. } => {}
        InputEvent::MouseWheel { delta } => {
            if delta == 0 || !(-1_200..=1_200).contains(&delta) {
                return Err(InputError::InvalidEvent);
            }
        }
    }
    Ok(())
}

pub fn inject_input(
    expected_windows_session_id: u32,
    event: InputEvent,
) -> Result<(), InputError> {
    validate_event(event)?;
    if expected_windows_session_id == 0 {
        return Err(InputError::WrongSession);
    }
    let current = current_process_session_id().map_err(|_| InputError::WrongSession)?;
    if current != expected_windows_session_id {
        return Err(InputError::WrongSession);
    }

    #[cfg(target_os = "windows")]
    {
        windows_impl::inject(event)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = event;
        Err(InputError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{InputError, InputEvent, MouseButton};
    use std::mem::size_of;

    const INPUT_MOUSE: u32 = 0;
    const INPUT_KEYBOARD: u32 = 1;

    const MOUSEEVENTF_MOVE: u32 = 0x0001;
    const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
    const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
    const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
    const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
    const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
    const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
    const MOUSEEVENTF_XDOWN: u32 = 0x0080;
    const MOUSEEVENTF_XUP: u32 = 0x0100;
    const MOUSEEVENTF_WHEEL: u32 = 0x0800;
    const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
    const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;

    const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const KEYEVENTF_SCANCODE: u32 = 0x0008;

    const XBUTTON1: u32 = 0x0001;
    const XBUTTON2: u32 = 0x0002;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyboardInput {
        virtual_key: u16,
        scan_code: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    union InputUnion {
        mouse: MouseInput,
        keyboard: KeyboardInput,
    }

    #[repr(C)]
    struct Input {
        kind: u32,
        value: InputUnion,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    }

    fn mouse(flags: u32, dx: i32, dy: i32, data: u32) -> Input {
        Input {
            kind: INPUT_MOUSE,
            value: InputUnion {
                mouse: MouseInput {
                    dx,
                    dy,
                    mouse_data: data,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        }
    }

    pub(super) fn inject(event: InputEvent) -> Result<(), InputError> {
        let input = match event {
            InputEvent::KeyScan {
                scan_code,
                key_up,
                extended,
            } => {
                let mut flags = KEYEVENTF_SCANCODE;
                if key_up {
                    flags |= KEYEVENTF_KEYUP;
                }
                if extended {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                Input {
                    kind: INPUT_KEYBOARD,
                    value: InputUnion {
                        keyboard: KeyboardInput {
                            virtual_key: 0,
                            scan_code,
                            flags,
                            time: 0,
                            extra_info: 0,
                        },
                    },
                }
            }
            InputEvent::MouseMoveRelative { dx, dy } => mouse(MOUSEEVENTF_MOVE, dx, dy, 0),
            InputEvent::MouseMoveAbsolute { x, y } => mouse(
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                i32::from(x),
                i32::from(y),
                0,
            ),
            InputEvent::MouseButton { button, key_up } => {
                let (flags, data) = match (button, key_up) {
                    (MouseButton::Left, false) => (MOUSEEVENTF_LEFTDOWN, 0),
                    (MouseButton::Left, true) => (MOUSEEVENTF_LEFTUP, 0),
                    (MouseButton::Right, false) => (MOUSEEVENTF_RIGHTDOWN, 0),
                    (MouseButton::Right, true) => (MOUSEEVENTF_RIGHTUP, 0),
                    (MouseButton::Middle, false) => (MOUSEEVENTF_MIDDLEDOWN, 0),
                    (MouseButton::Middle, true) => (MOUSEEVENTF_MIDDLEUP, 0),
                    (MouseButton::X1, false) => (MOUSEEVENTF_XDOWN, XBUTTON1),
                    (MouseButton::X1, true) => (MOUSEEVENTF_XUP, XBUTTON1),
                    (MouseButton::X2, false) => (MOUSEEVENTF_XDOWN, XBUTTON2),
                    (MouseButton::X2, true) => (MOUSEEVENTF_XUP, XBUTTON2),
                };
                mouse(flags, 0, 0, data)
            }
            InputEvent::MouseWheel { delta } => {
                mouse(MOUSEEVENTF_WHEEL, 0, 0, i32::from(delta) as u32)
            }
        };

        // SAFETY: input is one fully initialized INPUT record of the documented size.
        let sent = unsafe { SendInput(1, &input, size_of::<Input>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err(InputError::InjectionFailed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_events_fail_before_platform_access() {
        assert_eq!(
            inject_input(
                1,
                InputEvent::KeyScan {
                    scan_code: 0,
                    key_up: false,
                    extended: false,
                },
            ),
            Err(InputError::InvalidEvent)
        );
        assert_eq!(
            inject_input(1, InputEvent::MouseMoveRelative { dx: 0, dy: 0 }),
            Err(InputError::InvalidEvent)
        );
        assert_eq!(
            inject_input(1, InputEvent::MouseWheel { delta: 0 }),
            Err(InputError::InvalidEvent)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn valid_input_fails_closed_off_windows() {
        assert_eq!(
            inject_input(
                42,
                InputEvent::KeyScan {
                    scan_code: 30,
                    key_up: false,
                    extended: false,
                },
            ),
            Err(InputError::WrongSession)
        );
    }
}
