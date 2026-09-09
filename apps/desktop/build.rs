//! Generates the Tauri context: config, capability schemas and the Windows manifest.
//!
//! **The command list is not decoration.** Commands an application defines itself are
//! reachable from its own pages without ceremony, and that is why most Tauri projects
//! never write this. The canvas is not one of its own pages: it is served over http by
//! the child server, so it is a *remote* origin, and a remote origin reaches nothing that
//! the access-control list has not been told about. Declaring the commands here is what
//! generates the `allow-…` permissions that `capabilities/canvas.json` then grants.
//!
//! Without it the canvas loads, `window.__TAURI__` is present, the sidebar's desktop
//! group appears — and every call comes back `"shell_info not allowed. Plugin not
//! found"`. Everything looks wired and nothing works.
//!
//! The list is exactly the commands `invoke_handler!` registers, and the two capability
//! files split it by which page may call what.

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            // The boot page's, on the application's own origin.
            "boot_state",
            "open_download_page",
            // The canvas's, over the loopback address.
            "shell_info",
            "jump_to_session",
            "get_autostart",
            "set_autostart",
            // N-WP15a: recording mode, which the settings panel reads and writes.
            "get_task_text_off",
            "set_task_text_off",
            // N-WP17a: the ssh aliases the canvas is also reading. Same panel,
            // same shape, and the same blast radius as recording mode — writing
            // either one restarts the child server.
            "get_remotes",
            "set_remotes",
        ]),
    ))
    .expect("failed to build the Tauri context");
}
