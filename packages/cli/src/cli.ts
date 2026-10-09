import { CLI_VERSION, type Product } from './args.js';
import { failInput } from './errors.js';
import { emitFailure, emitSuccess } from './output.js';
import { runHub } from './hub.js';
import { runStage } from './stage.js';

function help(product: Product): string {
  return product === 'hub'
    ? 'Usage: hub <build|check|serve|thumbnail|publish> [options]'
    : 'Usage: stage <prepare|connect|doctor> [options] [origin]';
}

function splitCommand(product: Product, args: string[]): { command?: string; rest: string[] } {
  const known =
    product === 'hub'
      ? ['build', 'check', 'serve', 'thumbnail', 'publish']
      : ['prepare', 'connect', 'doctor'];
  if (args.length === 0) return { rest: [] };
  if (['--help', '-h', '--version'].includes(args[0])) return { rest: args };
  if (args[0] === '--json') {
    const commandIndex = args.findIndex((arg) => known.includes(arg));
    if (commandIndex < 0) {
      const candidate = args.findIndex((arg, index) => index > 0 && !arg.startsWith('-'));
      if (candidate < 0) return { rest: args };
      return {
        command: args[candidate],
        rest: [...args.slice(0, candidate), ...args.slice(candidate + 1)],
      };
    }
    return {
      command: args[commandIndex],
      rest: [...args.slice(0, commandIndex), ...args.slice(commandIndex + 1)],
    };
  }
  if (args[0].startsWith('-')) return { rest: args };
  return { command: args[0], rest: args.slice(1) };
}

export async function runCli(product: Product, args: string[]): Promise<void> {
  const { command, rest } = splitCommand(product, args);
  const json = args.includes('--json');
  try {
    if (command === undefined && rest.some((arg) => arg === '--version')) {
      emitSuccess(product, { version: CLI_VERSION }, json, CLI_VERSION);
      return;
    }
    if (command === undefined && rest.some((arg) => arg === '--help' || arg === '-h')) {
      if (product === 'hub') await runHub(undefined, rest, process.cwd());
      else await runStage(undefined, rest, process.cwd());
      return;
    }
    if (command === undefined && rest.some((arg) => arg.startsWith('-') && arg !== '--json'))
      failInput(`usage: ${help(product)}`);
    const cwd = process.cwd();
    if (product === 'hub') await runHub(command, rest, cwd);
    else await runStage(command, rest, cwd);
  } catch (error) {
    emitFailure(product, command, error, json);
  }
}
