#!/usr/bin/env node
import { runCli } from '../cli.js';

await runCli('stage', process.argv.slice(2));
