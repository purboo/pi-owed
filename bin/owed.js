#!/usr/bin/env node
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
const { main } = await import(existsSync(dist) ? dist.href : new URL('../src/cli.ts', import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));
