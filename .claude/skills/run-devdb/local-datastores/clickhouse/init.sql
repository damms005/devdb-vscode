-- Exercises int-corruption hardening (64/128/256-bit ints > 2^53), Decimal, Nullable, Array, Map, etc.
CREATE TABLE IF NOT EXISTS devdb.events
(
    id           UInt64,                       -- snowflake-style ids > 2^53
    user_id      Int64,
    big_signed   Int128,
    huge         UInt256,
    amount       Decimal(18, 4),
    price        Nullable(Decimal(10, 2)),
    note         Nullable(String),
    tags         Array(String),
    scores       Array(UInt64),
    attrs        Map(String, UInt64),
    status       Enum8('new' = 1, 'paid' = 2, 'refunded' = 3),
    country      LowCardinality(String),
    uid          UUID,
    created_at   DateTime64(3, 'UTC'),
    day          Date
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (id);

-- Known edge values first (easy to eyeball in the grid)
-- One row per line: the entrypoint's multiquery parser does not accept VALUES rows split across lines
INSERT INTO devdb.events VALUES (18446744073709551615, -9223372036854775808, -170141183460469231731687303715884105728, 115792089237316195423570985008687907853269984665640564039457584007913129639935, 99999999999999.9999, NULL, NULL, [], [], {}, 'new', 'NG', '00000000-0000-0000-0000-000000000001', '2024-01-01 00:00:00.000', '2024-01-01');
INSERT INTO devdb.events VALUES (9007199254740993, 9223372036854775807, 170141183460469231731687303715884105727, 0, -1.5, 10.25, 'id is 2^53+1: must not display as ...992', ['a','b'], [18446744073709551615], {'k': 18446744073709551615}, 'paid', 'US', '00000000-0000-0000-0000-000000000002', '2024-06-01 12:34:56.789', '2024-06-01');
INSERT INTO devdb.events SELECT 1234567890123456789, 42, 1, 1, 0.0001, 0, '', ['x'], [1,2,3], map('a',1,'b',2), 'refunded', 'GB', generateUUIDv4(), now64(3), today();

-- Bulk rows for pagination, query stats (rows/bytes read, elapsed) and cancel
INSERT INTO devdb.events
SELECT
    7000000000000000000 + number                                    AS id,
    toInt64(number) - 500000                                        AS user_id,
    toInt128(number) * toInt128('1000000000000000000000')           AS big_signed,
    toUInt256(number) * toUInt256('100000000000000000000000000000') AS huge,
    toDecimal64(number / 7, 4)                                      AS amount,
    if(number % 5 = 0, NULL, toDecimal32(number % 1000 / 3, 2))     AS price,
    if(number % 3 = 0, NULL, concat('note ', toString(number)))      AS note,
    arrayMap(i -> concat('t', toString(i)), range(number % 4))      AS tags,
    [number, number * 2, bitNot(number)]                           AS scores,
    map('clicks', number % 100, 'views', number * 10)               AS attrs,
    CAST(1 + number % 3, 'Enum8(\'new\' = 1, \'paid\' = 2, \'refunded\' = 3)') AS status,
    ['NG','US','GB','DE','IN'][1 + number % 5]                      AS country,
    generateUUIDv4()                                                AS uid,
    toDateTime64('2024-01-01 00:00:00', 3, 'UTC') + number          AS created_at,
    toDate('2024-01-01') + (number % 365)                           AS day
FROM numbers(200000);

-- Table without a sorting key (edit/delete should be refused or handled safely)
CREATE TABLE IF NOT EXISTS devdb.logs_no_key
(
    ts DateTime DEFAULT now(),
    level LowCardinality(String),
    message String
)
ENGINE = MergeTree ORDER BY tuple();
INSERT INTO devdb.logs_no_key (level, message) SELECT ['info','warn','error'][1 + number % 3], concat('log line ', toString(number)) FROM numbers(1000);

-- ReplacingMergeTree (mutations are async ALTER ... UPDATE on MergeTree family)
CREATE TABLE IF NOT EXISTS devdb.products
(
    sku UInt64,
    name String,
    price Decimal(10, 2),
    stock Int32,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at) ORDER BY sku;
INSERT INTO devdb.products (sku, name, price, stock) SELECT number + 1, concat('Product ', toString(number + 1)), (number % 500) + 0.99, number % 50 FROM numbers(500);

-- Large table for OOM guard (max_result_rows/bytes) and cancel (slow query)
CREATE TABLE IF NOT EXISTS devdb.big_numbers (n UInt64, s String) ENGINE = MergeTree ORDER BY n;
INSERT INTO devdb.big_numbers SELECT number, repeat('x', 100) FROM numbers(2000000);
