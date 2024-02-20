import { exec } from 'child_process';
import parse from 'csv-parse';
import { promisify } from 'util';

    const result = await runSqliteQueryNatively(database, query);
    const parsedResult = await parseSqliteOutput(result);

    console.log(parsedResult);

const execPromise = promisify(exec);
const parsePromise = promisify(parse);

async function runSqliteQueryNatively(database: string, query: string): Promise<string> {
    const command = process.platform === 'win32' ? `echo ${query} | sqlite3 -csv -header ${database}` : `echo "${query}" | sqlite3 -csv -header ${database}`;

    const { stdout } = await execPromise(command);
    return stdout;
}

async function parseSqliteOutput(output: string): Promise<Record<string, any>[]> {
    const records: Record<string, any>[] = await parsePromise(output, {
        delimiter: ',',
        trim: true,
        columns: true
    });
    return records;
}

export { runSqliteQueryNatively as runSqliteQuery, parseSqliteOutput };
