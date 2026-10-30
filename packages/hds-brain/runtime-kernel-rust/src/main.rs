fn main() {
    if let Err(reason) = blue_tanuki_runtime_kernel_shadow::run() {
        eprintln!("runtime_kernel_shadow_stopped: {reason}");
        std::process::exit(1);
    }
}
