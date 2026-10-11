import { existsSync } from 'node:fs';
import path from 'node:path';

/** The agent-engine checkout: code, plans, scripts. */
export const CODE_DIR = path.resolve(import.meta.dirname, '..');

/**
 * Where data/ and logs/ live and where engine processes run (their cwd). One checkout serves several
 * characters by giving each its own MICROBOT_ENGINE_HOME; unset, it is the checkout itself.
 */
export const ENGINE_HOME = process.env.MICROBOT_ENGINE_HOME ? path.resolve(process.env.MICROBOT_ENGINE_HOME) : CODE_DIR;

/** A path relative to the working directory, else to the checkout (plans/ live there, not in a character's home). */
export function codeFallback(file: string): string {
  return path.isAbsolute(file) || existsSync(file) ? file : path.join(CODE_DIR, file);
}
