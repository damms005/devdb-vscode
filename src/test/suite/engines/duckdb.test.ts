import * as assert from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { DuckDbEngine } from '../../../database-engines/duckdb-engine';

describe('DuckDB Tests', () => {
	let dbPath: string;
	let engine: DuckDbEngine;

	before(async function () {
		dbPath = join(tmpdir(), `devdb-duckdb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`);
		// Write-mode engine: these tests create tables / insert rows, so the file
		// must be opened read-write (the safe default is now read-only).
		engine = new DuckDbEngine(dbPath, { readOnly: false });
	});

	afterEach(async () => {
		const tables = await engine.getTables();
		for (const table of tables) {
			await engine.raw(`DROP TABLE IF EXISTS ${table}`);
		}
	});

	after(async function () {
		await engine.disconnect();
		if (existsSync(dbPath)) {
			rmSync(dbPath, { force: true });
		}
		engine.destroy();
	});

	it('should open a duckdb file and report a version', async () => {
		assert.strictEqual(await engine.isOkay(), true);
		const version = await engine.getVersion();
		assert.strictEqual(typeof version, 'string');
		assert.ok(version.length > 0);
	});

	it('should return table names', async () => {
		await engine.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR)`);
		await engine.raw(`CREATE TABLE products (id INTEGER PRIMARY KEY, name VARCHAR)`);

		const tables = await engine.getTables();
		assert.deepStrictEqual(tables.sort(), ['products', 'users']);
	});

	it('should return column definitions including a LIST column', async () => {
		await engine.raw(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY NOT NULL,
				name VARCHAR,
				price DOUBLE,
				tags INTEGER[]
			)
		`);

		const columns = await engine.getColumns('items');

		const byName = Object.fromEntries(columns.map((column) => [column.name, column]));

		assert.strictEqual(byName.id.isPrimaryKey, true);
		assert.strictEqual(byName.id.isNullable, false);
		assert.strictEqual(byName.id.isNumeric, true);

		assert.strictEqual(byName.name.isNumeric, false);
		assert.strictEqual(byName.name.isPlainTextType, true);
		assert.strictEqual(byName.name.isEditable, true);

		assert.strictEqual(byName.price.isNumeric, true);

		// LIST column: not numeric, not plain text, not editable
		assert.strictEqual(byName.tags.isNumeric, false);
		assert.strictEqual(byName.tags.isPlainTextType, false);
		assert.strictEqual(byName.tags.isEditable, false);
	});

	it('should return total rows', async () => {
		await engine.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR, age INTEGER)`);
		await engine.raw(`INSERT INTO users (id, name, age) VALUES (1, 'John', 30), (2, 'Jane', 25), (3, 'Bob', 40)`);

		const totalRows = await engine.getTotalRows('users', await engine.getColumns('users'));
		assert.strictEqual(totalRows, 3);
	});

	it('should return rows with JSON-serializable LIST/STRUCT values', async () => {
		await engine.raw(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name VARCHAR,
				tags INTEGER[],
				attrs STRUCT(color VARCHAR, size INTEGER)
			)
		`);

		await engine.raw(`
			INSERT INTO items (id, name, tags, attrs) VALUES
			(1, 'Widget', [1, 2, 3], {'color': 'red', 'size': 10}),
			(2, 'Gadget', [4, 5], {'color': 'blue', 'size': 20})
		`);

		const columns = await engine.getColumns('items');
		const result = await engine.getRows('items', columns, 10, 0);

		assert.ok(result);
		assert.strictEqual(result!.rows.length, 2);

		const first = result!.rows[0];
		assert.strictEqual(first.id, 1);
		assert.strictEqual(first.name, 'Widget');
		assert.deepStrictEqual(first.tags, [1, 2, 3]);
		assert.deepStrictEqual(first.attrs, { color: 'red', size: 10 });

		// Complex cells must survive JSON serialization (webview boundary)
		assert.doesNotThrow(() => JSON.stringify(result!.rows));
	});

	it('should return rows with a where clause', async () => {
		await engine.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR, age INTEGER)`);
		await engine.raw(`
			INSERT INTO users (id, name, age) VALUES
			(1, 'Jane', 25), (2, 'John', 30), (3, 'Bob', 40), (4, 'Alice', 30)
		`);

		const columns = await engine.getColumns('users');

		const rows = await engine.getRows('users', columns, 10, 0, { age: 30 });
		assert.strictEqual(rows?.rows.length, 2);
		assert.deepStrictEqual(rows?.rows.map((r) => r.name).sort(), ['Alice', 'John']);

		const bobRows = await engine.getRows('users', columns, 10, 0, { name: 'Bob' });
		assert.strictEqual(bobRows?.rows.length, 1);
		assert.strictEqual(bobRows?.rows[0].age, 40);
	});

	it('should return foreign key definitions', async () => {
		await engine.raw(`CREATE TABLE ParentTable (id INTEGER PRIMARY KEY)`);
		await engine.raw(`
			CREATE TABLE ChildTable (
				id INTEGER PRIMARY KEY,
				parentId INTEGER,
				FOREIGN KEY (parentId) REFERENCES ParentTable(id)
			)
		`);

		const columns = await engine.getColumns('ChildTable');
		const foreignKeyColumn = columns.find((column) => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	});

	it('should return SUMMARIZE rows via raw() (D1: no longer a silent no-op)', async () => {
		await engine.raw(`CREATE TABLE metrics (id INTEGER, amount DOUBLE, label VARCHAR)`);
		await engine.raw(`INSERT INTO metrics VALUES (1, 10.5, 'a'), (2, 20.0, 'b'), (3, 30.5, 'a')`);

		const rows = await engine.raw(`SUMMARIZE metrics`);

		assert.ok(Array.isArray(rows), 'SUMMARIZE must return a rows array, not a { changes } no-op');
		assert.strictEqual(rows.length, 3, 'one summary row per column');
		const columnNames = rows.map((row: any) => String(row.column_name)).sort();
		assert.deepStrictEqual(columnNames, ['amount', 'id', 'label']);

		const helperRows = await engine.summarize('metrics');
		assert.strictEqual(helperRows.length, 3);
	});

	it('locks file, network, extension and config access after opening', async () => {
		const outPath = join(tmpdir(), `devdb-duckdb-copy-${Date.now()}.csv`);
		const blocked = [
			`SELECT * FROM read_text('/etc/passwd')`,
			`COPY (SELECT 1) TO '${outPath}'`,
			`ATTACH '${join(tmpdir(), 'devdb-duckdb-attach.duckdb')}' AS other`,
			`INSTALL httpfs`,
			`LOAD httpfs`,
			`SET enable_external_access = true`,
			`SET threads = 1`,
		];

		for (const query of blocked) {
			await assert.rejects(engine.rawQuery(query), `expected rejection for: ${query}`);
		}
		assert.strictEqual(existsSync(outPath), false);

		// The database file itself stays writable when opened read-write.
		await engine.raw(`CREATE TABLE still_writable (id INTEGER)`);
		await engine.raw(`INSERT INTO still_writable VALUES (1)`);
		assert.strictEqual(await engine.getTotalRows('still_writable', []), 1);
	});

	it('rejects non-SELECT statements in readOnly rawQuery', async () => {
		await engine.raw(`CREATE TABLE ro_items (id INTEGER)`);

		const blocked = [
			`COPY ro_items TO 'x.csv'`,
			`ATTACH 'x.duckdb'`,
			`INSTALL httpfs`,
			`LOAD httpfs`,
			`SET threads = 1`,
			`PRAGMA version`,
			`/* c */ pragma table_info('ro_items')`,
			`EXPORT DATABASE 'x'`,
			`INSERT INTO ro_items VALUES (1)`,
			`WITH x AS (SELECT 1) INSERT INTO ro_items SELECT * FROM x`,
			`DROP TABLE ro_items`,
			`EXPLAIN ANALYZE INSERT INTO ro_items VALUES (2)`,
			`SELECT 1; DROP TABLE ro_items`,
		];

		for (const query of blocked) {
			await assert.rejects(engine.rawQuery(query, { readOnly: true }), `expected read-only rejection for: ${query}`);
		}

		assert.strictEqual(await engine.getTotalRows('ro_items', []), 0);
		assert.deepStrictEqual(await engine.rawQuery(`SELECT count(*) AS n FROM ro_items`, { readOnly: true }), [{ n: 0 }]);
	});

	it('caps rawQuery rows at 10,000 and flags truncation', async () => {
		const capped = await engine.rawQuery(`SELECT range AS n FROM range(25000)`);
		assert.strictEqual(capped.length, 10000);
		assert.strictEqual(capped.truncated, true);

		const whole = await engine.rawQuery(`SELECT range AS n FROM range(10)`, { readOnly: true });
		assert.strictEqual(whole.length, 10);
		assert.strictEqual(whole.truncated, undefined);
	});

	it('renders DuckDB value classes as display strings', async () => {
		await engine.raw(`
			CREATE TABLE typed AS SELECT
				99999999999999.9999::DECIMAL(18,4) AS dec,
				'aa7fcaad-df30-4f4e-8203-066517d2267a'::UUID AS uid,
				MAP {'theme': 1, 'lang': 2} AS prefs,
				'2024-01-01 02:00:00+00'::TIMESTAMPTZ AS created_at,
				'1980-01-02'::DATE AS birthday,
				'12:34:56'::TIME AS at_time,
				INTERVAL 90 MINUTE AS gap,
				'\\xDE\\xAD\\xBE\\xEF'::BLOB AS avatar,
				170141183460469231731687303715884105727::HUGEINT AS big,
				18446744073709551614::UBIGINT AS ubig,
				[1.50::DECIMAL(4,2), NULL] AS decs,
				{'day': '2024-05-06'::DATE, 'tags': ['a']} AS info
		`);

		const rows = await engine.rawQuery(`SELECT * FROM typed`);
		const row = rows[0];

		assert.strictEqual(row.dec, '99999999999999.9999');
		assert.strictEqual(row.uid, 'aa7fcaad-df30-4f4e-8203-066517d2267a');
		assert.deepStrictEqual(row.prefs, { theme: 1, lang: 2 });
		assert.match(row.created_at, /^2024-01-01 \d{2}:00:00[+-]\d{2}/);
		assert.strictEqual(row.birthday, '1980-01-02');
		assert.strictEqual(row.at_time, '12:34:56');
		assert.strictEqual(row.gap, '01:30:00');
		assert.strictEqual(row.avatar, '0xDEADBEEF');
		assert.strictEqual(row.big, '170141183460469231731687303715884105727');
		assert.strictEqual(row.ubig, '18446744073709551614');
		assert.deepStrictEqual(row.decs, ['1.50', null]);
		assert.deepStrictEqual(row.info, { day: '2024-05-06', tags: ['a'] });
		assert.doesNotThrow(() => JSON.stringify(rows));
	});

	it('summarizes per column when SUMMARIZE overflows on one column', async () => {
		await engine.raw(`CREATE TABLE huge (id INTEGER, big HUGEINT, amount DECIMAL(10,2))`);
		await engine.raw(`INSERT INTO huge VALUES
			(1, 170141183460469231731687303715884105726, 1.50),
			(2, 170141183460469231731687303715884105725, 2.50)`);

		const rows = await engine.summarize('huge');
		const byName = Object.fromEntries(rows.map((row) => [row.column_name, row]));

		assert.deepStrictEqual(Object.keys(byName), ['id', 'big', 'amount']);
		assert.strictEqual(byName.id.avg, '1.5');
		assert.strictEqual(byName.amount.max, '2.50');
		assert.strictEqual(byName.big.max, '170141183460469231731687303715884105726');
		assert.strictEqual(byName.big.count, 2);
		assert.match(byName.big.note, /unavailable: .*HUGEINT/);
		assert.strictEqual(typeof byName.amount.null_percentage, 'string');
		rows.forEach((row) => assert.deepStrictEqual(Object.keys(row), Object.keys(rows[0])));
	});

	it('summarizes large tables from a sample and says so', async function () {
		this.timeout(60000);
		await engine.raw(`CREATE TABLE many AS SELECT range AS id FROM range(5000001)`);

		const rows = await engine.summarize('many');
		assert.strictEqual(rows.length, 1);
		assert.match(rows[0].note, /^Sampled about 1,000,000 of 5,000,001 rows/);
		assert.ok(Number(rows[0].count) < 5000001);
	});

	it('interrupts a running query when the signal aborts', async function () {
		this.timeout(30000);
		await engine.raw(`CREATE TABLE heavy AS SELECT range AS id FROM range(3000000)`);

		const cancelled = new AbortController();
		setTimeout(() => cancelled.abort(), 300);
		const started = Date.now();
		await assert.rejects(
			engine.rawQuery(`SELECT count(*) FROM heavy a, heavy b WHERE a.id + b.id < 0`, { signal: cancelled.signal }),
			/INTERRUPT/i,
		);
		assert.ok(Date.now() - started < 5000, `interrupt took ${Date.now() - started} ms`);

		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(engine.summarize('heavy', aborted.signal));
		assert.strictEqual(await engine.getRows('heavy', await engine.getColumns('heavy'), 5, 0, undefined, aborted.signal), undefined);

		// The connection still works after an interrupt.
		assert.deepStrictEqual(await engine.rawQuery(`SELECT 1 AS ok`), [{ ok: 1 }]);
	});

	it('should disable edits and refuse mutations when opened read-only (D2/D4)', async () => {
		const readOnlyPath = join(tmpdir(), `devdb-duckdb-ro-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`);

		const writer = new DuckDbEngine(readOnlyPath, { readOnly: false });
		await writer.raw(`CREATE TABLE people (id INTEGER PRIMARY KEY, name VARCHAR)`);
		await writer.raw(`INSERT INTO people VALUES (1, 'Ada'), (2, 'Linus')`);
		await writer.disconnect();

		const readOnly = new DuckDbEngine(readOnlyPath, { readOnly: true });
		try {
			assert.strictEqual(readOnly.isReadOnly(), true);

			const columns = await readOnly.getColumns('people');
			assert.ok(columns.length > 0);
			assert.ok(columns.every((column) => column.isEditable === false), 'read-only columns must not be editable');

			// Reading still works
			const result = await readOnly.getRows('people', columns, 10, 0);
			assert.strictEqual(result?.rows.length, 2);

			// A mutation must throw, not silently no-op
			await assert.rejects(
				() => readOnly.commitChange({
					type: 'cell-update',
					table: 'people',
					column: { name: 'name', type: 'VARCHAR', isPrimaryKey: false, isPlainTextType: true, isNullable: true, isEditable: false },
					primaryKeyColumn: 'id',
					primaryKey: 1,
					newValue: 'Grace',
					originalValue: 'Ada',
				} as any),
				/read-only/i,
			);
		} finally {
			await readOnly.disconnect();
			readOnly.destroy();
			if (existsSync(readOnlyPath)) {
				rmSync(readOnlyPath, { force: true });
			}
		}
	});

	it('should open a CSV data file as a queryable view (D3)', async () => {
		const csvPath = join(tmpdir(), `devdb-duckdb-data-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
		writeFileSync(csvPath, 'id,name,score\n1,Ada,90\n2,Linus,85\n3,Grace,95\n');

		const dataEngine = new DuckDbEngine(':memory:', { dataFile: { path: csvPath, viewName: 'people' } });
		try {
			assert.strictEqual(await dataEngine.isOkay(), true);
			assert.strictEqual(dataEngine.isReadOnly(), true, 'data-file views are not editable');

			const tables = await dataEngine.getTables();
			assert.ok(tables.includes('people'), `expected view "people" in tables: ${tables.join(', ')}`);

			const columns = await dataEngine.getColumns('people');
			const columnNames = columns.map((column) => column.name).sort();
			assert.deepStrictEqual(columnNames, ['id', 'name', 'score']);
			assert.ok(columns.every((column) => column.isEditable === false));

			const result = await dataEngine.getRows('people', columns, 10, 0);
			assert.strictEqual(result?.rows.length, 3);
			assert.deepStrictEqual(result?.rows.map((row) => row.name).sort(), ['Ada', 'Grace', 'Linus']);

			// The view keeps reading its file after lock-down, but cannot write it.
			await assert.rejects(dataEngine.rawQuery(`COPY (SELECT 1) TO '${csvPath}'`), /Permission Error/);
			await assert.rejects(dataEngine.rawQuery(`SELECT * FROM read_text('/etc/passwd')`), /Permission Error/);

			// The count is cached for the session: a later change to the file is not re-parsed.
			assert.strictEqual(await dataEngine.getTotalRows('people', columns), 3);
			writeFileSync(csvPath, 'id,name,score\n1,Ada,90\n');
			assert.strictEqual(await dataEngine.getTotalRows('people', columns), 3);
		} finally {
			await dataEngine.disconnect();
			dataEngine.destroy();
			if (existsSync(csvPath)) {
				rmSync(csvPath, { force: true });
			}
		}
	});
});
