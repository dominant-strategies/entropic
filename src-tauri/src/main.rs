#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = entropic_lib::maybe_handle_cli_mode() {
        std::process::exit(exit_code);
    }
    entropic_lib::run()
}
