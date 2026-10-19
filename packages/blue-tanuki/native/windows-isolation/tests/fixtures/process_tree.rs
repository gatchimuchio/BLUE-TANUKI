use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("parent") => {
            let executable = std::env::current_exe().expect("current executable");
            Command::new(executable)
                .arg("child")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn direct child");
        }
        Some("child") => {
            thread::sleep(Duration::from_secs(4));
            fs::write("late-child.txt", "late").expect("write child marker");
        }
        _ => std::process::exit(2),
    }
}
