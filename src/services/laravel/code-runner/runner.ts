import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';

export class Runner {
    /**
     * Boot laravel and run php code.
     */
    public static async runLaravel(useStatements: string = '', code: string): Promise<[string, any[], string][]> {
        // Check if we're in a Laravel project
        if (!fs.existsSync(this.getProjectPath("vendor/autoload.php")) ||
            !fs.existsSync(this.getProjectPath("bootstrap/app.php"))) {
            return Promise.reject(new Error("Not in a Laravel project directory"));
        }

        code = `
            ${useStatements}
            require '${this.getProjectPath("vendor/autoload.php", true)}';
            require_once '${this.getProjectPath("bootstrap/app.php", true)}';

            class VscodeLaravelExtraIntellisenseProvider extends \\Illuminate\\Support\\ServiceProvider {
                public function register() {}
                public function boot() {
                    if (method_exists($this->app['log'], 'setHandlers')) {
                        $this->app['log']->setHandlers([new \\Monolog\\Handler\\ProcessHandler()]);
                    }
                }
            }
            $app->register(new VscodeLaravelExtraIntellisenseProvider($app));

            $kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);

            $status = $kernel->handle(
                $input = new Symfony\\Component\\Console\\Input\\ArgvInput,
                new Symfony\\Component\\Console\\Output\\NullOutput
            );

            if ($status === 0) {
                $queries = [];
                \\DB::listen(function($query) use (&$queries) {
                    $fullQuery = '';
                    if (count($query->bindings) > 0) {
                        foreach ($query->bindings as $binding) {
                            $value = is_numeric($binding) ? $binding : "'" . $binding . "'";
                            $fullQuery = preg_replace('/\\?/', $value, $query->sql, 1);
                        }
                    }

                    $queries[] = [$query->sql, $query->bindings, $fullQuery];
                });

                try {
                    ${code}
                } catch (\\Throwable $e) {
                    echo '___DEVDB_ERROR_OUTPUT_START___';
                    echo $e->getMessage();
                    echo '___DEVDB_ERROR_OUTPUT_END___';
                    exit(1);
                }

                echo '___DEVDB_OUTPUT_START___';
                echo json_encode($queries);
                echo '___DEVDB_OUTPUT_END___';
            }

            $kernel->terminate($input, $status);
            exit($status);
        `;

        const result = await this.runPhp(code);

        // Check for error output first
        const errorMatch = /___DEVDB_ERROR_OUTPUT_START___([\s\S]*)___DEVDB_ERROR_OUTPUT_END___/.exec(result);
        if (errorMatch) {
            throw new Error(errorMatch[1].trim());
        }

        // Check for regular output
        const match = /___DEVDB_OUTPUT_START___([\s\S]*)___DEVDB_OUTPUT_END___/.exec(result);
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
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
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
        const basePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const fullPath = `${basePath}/${path}`;
        return escape ? fullPath.replace(/\\/g, '\\\\') : fullPath;
    }
}