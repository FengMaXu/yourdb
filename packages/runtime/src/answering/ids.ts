/** Branded domain identities of the Answering module. */

/**
 * Domain identities are branded at the Answering boundary. Constructors are
 * intentionally private to this module; callers receive opaque strings from
 * the five public use cases and must still be checked by the Store.
 */
declare const identityBrand: unique symbol;
export type Id<K extends string> = string & { readonly [identityBrand]: K };

export type TaskId = Id<"TaskId">;
export type RevisionId = Id<"RevisionId">;
export type ReadyRevisionId = Id<"ReadyRevisionId">;
export type EvidenceId = Id<"EvidenceId">;
export type QualifiedEvidenceId = Id<"QualifiedEvidenceId">;
export type AlternativeId = Id<"AlternativeId">;
export type CandidateId = Id<"CandidateId">;
export type PrivateResultRef = Id<"PrivateResultRef">;
export type PublicationId = Id<"PublicationId">;

export type NonEmpty<T> = readonly [T, ...T[]];
