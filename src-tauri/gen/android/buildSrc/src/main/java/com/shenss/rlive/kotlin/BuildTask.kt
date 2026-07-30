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

/**
 * Runs `bun tauri android android-studio-script` for one ABI/profile.
 *
 * Uses [ExecOperations] and configuration-time [rootDir] so this task stays
 * compatible with Gradle 9+ (no Task.project / Project.exec at execution time).
 */
abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @get:Input
    abstract val rootDirRel: Property<String>

    @get:Input
    abstract val target: Property<String>

    @get:Input
    abstract val release: Property<Boolean>

    /** Absolute app/crate root; resolved at configuration time from [rootDirRel]. */
    @get:Internal
    abstract val rootDir: DirectoryProperty

    @TaskAction
    fun assemble() {
        val executable = "bun"
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
                throw e
            }
        }
    }

    private fun runTauriCli(executable: String) {
        val args = mutableListOf("tauri", "android", "android-studio-script")

        if (logger.isEnabled(LogLevel.DEBUG)) {
            args.add("-vv")
        } else if (logger.isEnabled(LogLevel.INFO)) {
            args.add("-v")
        }
        if (release.get()) {
            args.add("--release")
        }
        args.add("--target")
        args.add(target.get())

        execOperations.exec {
            workingDir(rootDir.get().asFile)
            executable(executable)
            args(args)
        }.assertNormalExitValue()
    }
}
