import { createTransport } from './transport.js';
import { nodeRuntime } from './node-runtime.js';
import type { CreateDeckOptions } from './contracts.js';

export function createNodeTransport(options: CreateDeckOptions = {}) {
  return createTransport(options, nodeRuntime);
}
