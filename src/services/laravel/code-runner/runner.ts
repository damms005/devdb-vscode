import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { getBasePath } from '../../workspace';

export class Runner {
    /**
     * Boot laravel and run php code.
     */
    private static readonly DEVDB_ERROR_OUTPUT_START = '___DEVDB_ERROR_OUTPUT_START___';
    private static readonly DEVDB_OUTPUT_START = '___DEVDB_OUTPUT_START___';
    private static readonly DEVDB_OUTPUT_END = '___DEVDB_OUTPUT_END___';

    public static async runLaravelCode(useStatements: string = '', code: string): Promise<[string, any[], string][]> {
        // Check if we're in a Laravel project
        if (!fs.existsSync(this.getProjectPath("vendor/autoload.php")) ||
            !fs.existsSync(this.getProjectPath("bootstrap/app.php"))) {
            return Promise.reject(new Error("Not in a Laravel project directory"));
        }

        code = `
            ${useStatements}
            require '${this.getProjectPath("vendor/autoload.php", true)}';
            require_once '${this.getProjectPath("bootstrap/app.php", true)}';

            class VsCodeDevDbProvider extends \\Illuminate\\Support\\ServiceProvider {
                public function register() {}
                public function boot() {
                    if (method_exists($this->app['log'], 'setHandlers')) {
                        $this->app['log']->setHandlers([new \\Monolog\\Handler\\ProcessHandler()]);
                    }
                }
            }
            $app->register(new VsCodeDevDbProvider($app));

            $kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);

            $status = $kernel->handle(
                $input = new Symfony\\Component\\Console\\Input\\ArgvInput,
                new Symfony\\Component\\Console\\Output\\NullOutput
            );

            if ($status === 0) {
                $queries = [];
                \\DB::listen(function($query) use (&$queries) {
                    $boundQuery = $query->sql; // query with placeholders values bound to the real values
                    if (count($query->bindings) > 0) {
                        foreach ($query->bindings as $binding) {
                            $value = is_numeric($binding) ? $binding : "'" . addslashes($binding) . "'";
                            $boundQuery = preg_replace('/\\?/', $value, $boundQuery, 1);
                        }
                    }

                    $queries[] = [$query->sql, $query->bindings, $boundQuery];
                });

                try {
                    ${code}
                } catch (\\Throwable $e) {
                    echo '${this.DEVDB_ERROR_OUTPUT_START}';
                    echo $e->getMessage();
                    echo '${this.DEVDB_OUTPUT_END}';
                    exit(1);
                }

                echo '${this.DEVDB_OUTPUT_START}';
                echo json_encode($queries);
                echo '${this.DEVDB_OUTPUT_END}';
            }

            $kernel->terminate($input, $status);
            exit($status);
        `;

        let result = null;
        try {
            result = await this.runPhp(code);
        } catch (error) {
            error = this.cleanOutcome(String(error))

            // remove parts of the PHP error that are irrelevant and will be inaccurate/unhelpful in this context
            error = (error as string)
                .trim()
                .replace(/in Command line code on line \d+$/g, '');

            return Promise.reject(`An issue occurred while running the PHP code. ${error}`);
        }

        // Check for error output first
        const errorMatch = new RegExp(`${this.DEVDB_ERROR_OUTPUT_START}([\\s\\S]*)${this.DEVDB_OUTPUT_END}`).exec(result);
        if (errorMatch) {
            throw new Error(errorMatch[1].trim());
        }

        // Check for regular output
        const match = new RegExp(`${this.DEVDB_OUTPUT_START}([\\s\\S]*)${this.DEVDB_OUTPUT_END}`).exec(result);
        if (match) {
            try {
                return JSON.parse(match[1].trim());
            } catch (error) {
                throw new Error(`Failed to parse SQL queries from output: ${String(error)}`);
            }
        }

        throw new Error(`Failed to parse output: ${result}`);
    }

    /**
     * Run simple PHP code
     */
    private static async runPhp(code: string): Promise<string> {
        code = code.replace(/\"/g, "\\\"");
        // code = code.replace(/(?:\r\n|\r|\n)/g, ' ');

        // Escape special characters for Unix-like systems
        if (['linux', 'openbsd', 'sunos', 'darwin'].some(platform => os.platform().includes(platform))) {
            code = code.replace(/\$/g, "\\$");
            code = code.replace(/\\\\'/g, '\\\\\\\\\'');
            code = code.replace(/\\\\"/g, '\\\\\\\\\"');
        }

        const command = `php -r "${code}"`;

        return new Promise((resolve, reject) => {
            cp.exec(command, {
                cwd: getBasePath()
            }, (err, stdout, stderr) => {
                if (err) {
                    reject(stderr || stdout);
                    return;
                }
                resolve(stdout);
            });
        });
    }

    /**
     * Get the Laravel project path
     */
    private static getProjectPath(path: string, escape: boolean = false): string {
        const basePath = getBasePath() || '';
        const fullPath = `${basePath}/${path}`;
        return escape ? fullPath.replace(/\\/g, '\\\\') : fullPath;
    }

    /**
     * Removes boundary texts like, ___DEVDB_ERROR_OUTPUT_START___, etc from the output
     */
    public static cleanOutcome(outcome: string): string {
        return outcome
            .replace(this.DEVDB_ERROR_OUTPUT_START, '')
            .replace(this.DEVDB_OUTPUT_START, '')
            .replace(this.DEVDB_OUTPUT_END, '');
    }
}