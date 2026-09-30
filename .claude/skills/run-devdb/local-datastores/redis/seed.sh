#!/bin/sh
# Seeds a Redis-compatible server. Usage: seed.sh <host> <port> [password]
set -e
H=$1; P=$2; PW=$3
R="redis-cli -h $H -p $P"
[ -n "$PW" ] && R="$R -a $PW --no-auth-warning"
until $R PING | grep -q PONG; do sleep 1; done
$R FLUSHALL >/dev/null

# strings (+ TTLs)
$R SET greeting "hello world" >/dev/null
$R SET counter 42 >/dev/null
$R SET "key with spaces" "value with spaces" >/dev/null
$R SET "unicode:ключ:键" "ünïcödé ✓" >/dev/null
$R SET config:json '{"feature":"x","enabled":true,"limits":[1,2,3]}' >/dev/null
$R SET session:abc123 '{"userId":1}' EX 3600 >/dev/null
$R SET session:def456 '{"userId":2}' EX 120 >/dev/null
$R SET session:short-lived '{"userId":3}' EX 30 >/dev/null
$R SET cache:product:1 '{"name":"Widget"}' PX 900000 >/dev/null
$R SET bignum 18446744073709551615 >/dev/null

# hashes
$R HSET user:1 name "Ada Lovelace" email ada@example.com age 36 >/dev/null
$R HSET user:2 name "Alan Turing" email alan@example.com age 41 >/dev/null
$R HSET user:3 name "Grace Hopper" email grace@example.com age 85 >/dev/null
$R EXPIRE user:3 7200 >/dev/null

# lists
$R RPUSH queue:emails job-1 job-2 job-3 job-4 job-5 >/dev/null
$R RPUSH queue:sms s-1 s-2 >/dev/null

# sets / sorted sets
$R SADD tags:post:1 redis db cache >/dev/null
$R SADD tags:post:2 valkey fork oss >/dev/null
$R ZADD leaderboard 100 alice 250 bob 75 carol 300 dave >/dev/null

# streams
$R XADD events:orders '*' orderId 1001 status created amount 19.99 >/dev/null
$R XADD events:orders '*' orderId 1001 status paid amount 19.99 >/dev/null
$R XADD events:orders '*' orderId 1002 status created amount 5.00 >/dev/null
$R XADD events:audit '*' actor admin action login >/dev/null

# bulk data for pagination / natural sort / namespace overview (natural sort: item:2 < item:10)
$R EVAL "for i=1,5000 do redis.call('SET','bulk:item:'..i, 'v'..i) end return 1" 0 >/dev/null
$R EVAL "for i=1,1500 do redis.call('SET','cache:page:'..i, 'html'..i, 'EX', 86400) end return 1" 0 >/dev/null
$R EVAL "for i=1,300 do redis.call('HSET','customer:'..i, 'name', 'Customer '..i, 'tier', (i % 3 == 0) and 'gold' or 'silver') end return 1" 0 >/dev/null
# large collections: bounded per-key reads
$R EVAL "for i=1,20000 do redis.call('HSET','bighash', 'field'..i, i) end return 1" 0 >/dev/null
$R EVAL "for i=1,20000 do redis.call('RPUSH','biglist', 'e'..i) end return 1" 0 >/dev/null
$R EVAL "for i=1,20000 do redis.call('ZADD','bigzset', i, 'm'..i) end return 1" 0 >/dev/null

# second logical DB
$R -n 1 SET db1:only "this lives in DB 1" >/dev/null
$R -n 1 HSET db1:user name "db one" >/dev/null

echo "seeded $H:$P -> $($R DBSIZE) keys in db0"
