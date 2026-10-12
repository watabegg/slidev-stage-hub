#!/usr/bin/env node
import { runCli } from '../cli.js';

await runCli('hub', process.argv.slice(2));
