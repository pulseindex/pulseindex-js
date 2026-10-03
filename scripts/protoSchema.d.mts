export interface ProtoSchema {
  rpcs: string[];
  messages: Record<string, string[]>;
  enums: Record<string, string[]>;
}
export function parseProtoSchema(text: string): ProtoSchema;
export function diffProtoSchemas(expected: ProtoSchema, actual: ProtoSchema): string[];

/**
 * Differences that matter between the engine's proto and the vendored copy.
 * An RPC missing from the vendored copy is reported unless it is named in
 * `omitted`, together with its Request and Response messages.
 */
export function diffProtoSubset(
  engine: ProtoSchema,
  vendored: ProtoSchema,
  omitted?: string[],
): string[];
