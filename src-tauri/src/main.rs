// 防止 Windows 发布版出现额外的控制台窗口，勿删！！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rlive_lib::run()
}
