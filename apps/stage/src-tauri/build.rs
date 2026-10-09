fn main() {
    #[cfg(feature = "desktop")]
    {
        // Keep cargo build/run usable without a separate frontend command.
        for path in [
            "../src",
            "../tsconfig.json",
            "../scripts/build-ui.mjs",
            "../../../package.json",
            "../../../pnpm-lock.yaml",
            "../../../packages/protocol/src",
            "../../../packages/protocol/scripts/build.mjs",
            "../../../packages/protocol/tsconfig.json",
        ] {
            println!("cargo:rerun-if-changed={path}");
        }
        let status = std::process::Command::new("node")
            .arg("../scripts/build-ui.mjs")
            .status()
            .expect("Node.js is required to compile the native TypeScript UI");
        assert!(status.success(), "Native TypeScript UI compilation failed");
        tauri_build::build();
    }
}
