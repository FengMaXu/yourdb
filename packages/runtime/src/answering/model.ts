/**
 * The Answering domain model, split by responsibility: identities (ids.ts),
 * stored records (records.ts), returned projections (view-types.ts), and
 * use-case inputs with their shared helpers (commands.ts). Internal modules
 * keep importing from here.
 */
export * from "./ids.js";
export * from "./records.js";
export * from "./view-types.js";
export * from "./commands.js";
