// Без окна консоли в собранной версии
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zvuk_glass_lib::run()
}
