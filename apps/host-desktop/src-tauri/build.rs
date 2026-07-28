fn main() {
    #[cfg(feature = "desktop-runtime")]
    tauri_build::build();
}
