import * as assert from 'assert';
import { MongodbEngine } from '../../../database-engines/mongodb-engine';
import { MssqlEngine } from '../../../database-engines/mssql-engine';

describe('Read-only rawQuery without a live server', () => {
	describe('MongodbEngine', () => {
		function engineWithFakeDb(): { engine: MongodbEngine, calls: string[] } {
			const calls: string[] = [];
			const engine = new MongodbEngine({ name: 'fake', type: 'mongodb', database: 'app' });
			(engine as any).db = {
				collection: () => ({
					find: () => ({ limit: () => ({ toArray: async () => { calls.push('find'); return [{ a: 1 }]; } }) }),
					aggregate: () => ({ toArray: async () => { calls.push('aggregate'); return []; } }),
					countDocuments: async () => { calls.push('count'); return 1; },
				}),
			};
			return { engine, calls };
		}

		it('runs find/aggregate/count reads', async () => {
			const { engine, calls } = engineWithFakeDb();
			await engine.rawQuery(JSON.stringify({ collection: 'users', operation: 'find', query: { filter: { a: 1 } } }), { readOnly: true });
			await engine.rawQuery(JSON.stringify({ collection: 'users', operation: 'aggregate', query: { pipeline: [{ $match: { a: 1 } }] } }), { readOnly: true });
			assert.deepStrictEqual(calls, ['find', 'aggregate']);
		});

		for (const [label, query] of [
			['$out', { collection: 'users', operation: 'aggregate', query: { pipeline: [{ $match: {} }, { $out: 'copy' }] } }],
			['$merge', { collection: 'users', operation: 'aggregate', query: { pipeline: [{ $merge: { into: 'copy' } }] } }],
			['nested $out', { collection: 'users', operation: 'aggregate', query: { pipeline: [{ $facet: { x: [{ $out: 'copy' }] } }] } }],
			['$where', { collection: 'users', operation: 'find', query: { filter: { $where: 'sleep(1000)' } } }],
			['$function', { collection: 'users', operation: 'aggregate', query: { pipeline: [{ $addFields: { x: { $function: { body: 'x', args: [], lang: 'js' } } } }] } }],
			['a write operation', { collection: 'users', operation: 'deleteMany', query: {} }],
		] as const) {
			it(`rejects ${label}`, async () => {
				const { engine, calls } = engineWithFakeDb();
				await assert.rejects(engine.rawQuery(JSON.stringify(query), { readOnly: true }), /Read-only mode/);
				assert.deepStrictEqual(calls, []);
			});
		}
	});

	describe('MssqlEngine', () => {
		function engineWithFakeKnex(): { engine: MssqlEngine, log: string[] } {
			const log: string[] = [];
			const trx = {
				raw: async (sql: string) => { log.push(`raw:${sql}`); return [{ one: 1 }]; },
				rollback: async () => { log.push('rollback'); },
			};
			const engine = new MssqlEngine({ transaction: async () => trx } as any);
			return { engine, log };
		}

		it('runs a SELECT in a transaction that is rolled back', async () => {
			const { engine, log } = engineWithFakeKnex();
			const rows = await engine.rawQuery('SELECT 1 AS one', { readOnly: true });
			assert.deepStrictEqual(rows, [{ one: 1 }]);
			assert.deepStrictEqual(log, ['raw:SELECT 1 AS one', 'rollback']);
		});

		for (const bypass of [
			'SELECT 1 DROP TABLE users',
			'SELECT * INTO copy FROM users',
			'/**/DELETE FROM users',
			"SELECT 1; EXEC xp_cmdshell 'dir'",
			'WITH x AS (SELECT 1 AS a) UPDATE users SET a = 1',
			"SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')",
		]) {
			it(`rejects ${JSON.stringify(bypass)}`, async () => {
				const { engine, log } = engineWithFakeKnex();
				await assert.rejects(engine.rawQuery(bypass, { readOnly: true }), /Read-only mode/);
				assert.deepStrictEqual(log, []);
			});
		}

		it('allows keywords inside string literals and bracketed identifiers', async () => {
			const { engine } = engineWithFakeKnex();
			await engine.rawQuery("SELECT 'DROP TABLE users' AS [update]", { readOnly: true });
		});
	});
});
