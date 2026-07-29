const COMMANDS: &[&str] = &[
    "get_state",
    "set_brightness",
    "set_volume",
    "reset_brightness",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
