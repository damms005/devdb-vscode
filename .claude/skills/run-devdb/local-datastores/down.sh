#!/usr/bin/env bash
cd "$(dirname "$0")" && docker compose --profile seed down -v --remove-orphans
