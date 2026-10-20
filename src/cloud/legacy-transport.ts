import { createParse } from './parse-facade.js';
import type { TransportClient } from './transport.js';

/** 3.0 parse/convert/resume on top of the transport, for the legacy client only. */
export function withLegacyParse(transport: TransportClient) {
  return {
    ...transport,
    ...createParse({
      createTask: (params) => transport.tasks.create(params),
      waitTask: (id, options) => transport.tasks.wait(id, options),
      downTask: (id, options) => transport.tasks.down(id, options),
    }),
  };
}
