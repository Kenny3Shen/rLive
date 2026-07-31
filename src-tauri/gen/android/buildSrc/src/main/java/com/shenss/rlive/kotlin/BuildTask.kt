import javax.inject.Inject
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.logging.LogLevel
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Input
    abstract val rootDirRel: Property<String>

    @get:Input
    abstract val target: Property<String>

    @get:Input
    abstract val release: Property<Boolean>

    /** Working directory for the Tauri CLI, resolved at configuration time. */
    @get:Internal
    abstract val rootDir: DirectoryProperty

    @get:Inject
    abstract val execOperations: ExecOperations

    @TaskAction
    fun assemble() {
        val executable = """bun""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val workingDirFile = rootDir.get().asFile
        val targetName = target.get()
        val isRelease = release.get()
        val args = listOf("tauri", "android", "android-studio-script");

        execOperations.exec {
            workingDir(workingDirFile)
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (isRelease) {
                args("--release")
            }
            args(listOf("--target", targetName))
        }.assertNormalExitValue()
    }
}
