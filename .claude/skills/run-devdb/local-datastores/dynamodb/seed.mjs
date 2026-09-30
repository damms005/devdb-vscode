// Seeds DynamoDB Local (default http://localhost:8000) with the SAME SDK DevDb ships (@aws-sdk/client-dynamodb).
// Tables: users  (PK only; nested maps/lists/sets, a number > 2^53, binary, BOOL, NULL),
//         orders (PK + SK, GSI "status-index"),
//         events (PK + numeric SK, 5,000 items for pagination).
// Usage: node dynamodb/seed.mjs   (DYNAMODB_ENDPOINT / DEVDB_REPO override the defaults). Recreates the tables.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.env.DEVDB_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sdk = createRequire(join(repo, 'package.json'))('@aws-sdk/client-dynamodb');
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const client = new sdk.DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'devdblocal', secretAccessKey: 'devdblocal' } });

const tables = {
  users: {
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
  },
  orders: {
    KeySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' }, { AttributeName: 'orderId', KeyType: 'RANGE' }],
    AttributeDefinitions: [
      { AttributeName: 'customerId', AttributeType: 'S' },
      { AttributeName: 'orderId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'total', AttributeType: 'N' },
    ],
    GlobalSecondaryIndexes: [{
      IndexName: 'status-index',
      KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'total', KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'ALL' },
    }],
  },
  events: {
    KeySchema: [{ AttributeName: 'deviceId', KeyType: 'HASH' }, { AttributeName: 'ts', KeyType: 'RANGE' }],
    AttributeDefinitions: [{ AttributeName: 'deviceId', AttributeType: 'S' }, { AttributeName: 'ts', AttributeType: 'N' }],
  },
};

const existing = new Set((await client.send(new sdk.ListTablesCommand({}))).TableNames ?? []);
for (const [TableName, definition] of Object.entries(tables)) {
  if (existing.has(TableName)) {
    await client.send(new sdk.DeleteTableCommand({ TableName }));
  }
  await client.send(new sdk.CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST', ...definition }));
}

async function putAll(TableName, items) {
  for (let i = 0; i < items.length; i += 25) {
    let requests = { [TableName]: items.slice(i, i + 25).map(Item => ({ PutRequest: { Item } })) };
    while (requests && Object.keys(requests).length) {
      const response = await client.send(new sdk.BatchWriteItemCommand({ RequestItems: requests }));
      requests = response.UnprocessedItems;
    }
  }
}

const cities = ['Lagos', 'London', 'Berlin', 'Austin'];
const users = Array.from({ length: 20 }, (_, n) => {
  const i = n + 1;
  const item = {
    userId: { S: `user-${String(i).padStart(3, '0')}` },
    name: { S: `User ${i}` },
    age: { N: String(20 + (i % 40)) },
    active: { BOOL: i % 3 !== 0 },
    email: i % 5 === 0 ? { NULL: true } : { S: `user${i}@example.com` },
    address: { M: { city: { S: cities[i % 4] }, zip: { S: String(10000 + i * 37) }, geo: { M: { lat: { N: '6.5244' }, lng: { N: '3.3792' } } } } },
    tags: { SS: [`t${i % 5}`, `t${(i % 7) + 10}`] },
    scores: { NS: [String(i), String(i * 10)] },
    history: { L: [{ S: 'signup' }, { N: String(i) }, { M: { step: { S: 'verify' }, ok: { BOOL: true } } }] },
  };
  if (i === 1) {
    item.bigCounter = { N: '12345678901234567890' };
    item.avatar = { B: Buffer.from('DevDb binary \u0000\u0001\u0002') };
    item.files = { BS: [Buffer.from('a'), Buffer.from('bc')] };
  }
  return item;
});
await putAll('users', users);

const statuses = ['pending', 'paid', 'shipped', 'cancelled'];
const orders = [];
for (let c = 1; c <= 10; c++) {
  for (let o = 1; o <= 12; o++) {
    orders.push({
      customerId: { S: `cust-${String(c).padStart(2, '0')}` },
      orderId: { S: `2026-0${1 + (o % 9)}-${String(o).padStart(3, '0')}` },
      status: { S: statuses[(c + o) % 4] },
      total: { N: (c * 13.5 + o).toFixed(2) },
      items: { L: [{ M: { sku: { S: `SKU-${o}` }, qty: { N: String(1 + (o % 3)) } } }] },
    });
  }
}
await putAll('orders', orders);

const events = [];
for (let d = 1; d <= 50; d++) {
  for (let t = 0; t < 100; t++) {
    events.push({
      deviceId: { S: `device-${String(d).padStart(2, '0')}` },
      ts: { N: String(1767225600 + t * 60) },
      level: { S: ['info', 'warn', 'error'][t % 3] },
      reading: { N: (d + t / 10).toFixed(1) },
    });
  }
}
await putAll('events', events);

const counts = {};
for (const TableName of Object.keys(tables)) {
  counts[TableName] = (await client.send(new sdk.ScanCommand({ TableName, Select: 'COUNT' }))).Count;
}
console.log(`DynamoDB Local seeded at ${endpoint}:`, JSON.stringify(counts));
