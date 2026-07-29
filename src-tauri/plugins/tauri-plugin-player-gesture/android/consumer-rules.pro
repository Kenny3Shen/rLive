# The Tauri runtime constructs this plugin by its class name and reflects over
# @Command methods, so it must retain the plugin class in release builds.
-keep class app.tauri.player_gesture.PlayerGesturePlugin { *; }
