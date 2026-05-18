// Make ROM (Remote Open Module) artifact shape.
//
// Story 5.7 / FR33: the pipeline produces this artifact when a per-MCP
// config requests Make adaptation. v1 ONLY generates the artifact —
// no publication to Make.com. A future story will pick this up and
// route it through Make's UI / API.
//
// The shape below is a pragmatic v1 approximation of Make's module
// descriptor: enough fields for a human to import + finish wiring at
// make.com, with placeholders called out for any field Make demands
// that we can't auto-fill from the MCP source (e.g. the HTTP
// communication spec — MCP tools speak stdio JSON-RPC, not HTTP, so
// each action needs a Make-hosted gateway to bridge it). We surface
// these gaps explicitly via `placeholder: true` and a `placeholderReason`
// so reviewers see what they still need to fill in.

export type MakeParamType =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'json';

export interface MakeSelectOption {
  label: string;
  value: string | number;
}

export interface MakeParameter {
  /** snake_case parameter id matching the MCP tool's JSON-Schema property. */
  name: string;
  /** Title-cased label shown in Make's UI. */
  label: string;
  type: MakeParamType;
  required: boolean;
  default?: string | number | boolean | Record<string, unknown> | unknown[];
  help?: string;
  options?: MakeSelectOption[];
  /** Marks parameters lowered from nested object/array schemas to 'json'. */
  loweredFromComplexSchema?: boolean;
}

export interface MakeAction {
  /** Tool name from the MCP, snake_case. */
  name: string;
  label: string;
  description: string;
  parameters: MakeParameter[];
  /**
   * Communication spec is a Make-specific HTTP descriptor. Since MCP
   * tools speak stdio JSON-RPC, the pipeline can't auto-derive the
   * HTTP routes — the operator must point each action at a hosted
   * MCP-over-HTTP gateway (or hand-edit per-action). We emit a
   * placeholder block so reviewers see the gap.
   */
  communication: {
    placeholder: true;
    placeholderReason: string;
    /** The MCP tool name the gateway should map this action to. */
    mcpToolName: string;
  };
}

export interface MakeConnectionField {
  /** Env-var name on the source MCP side. */
  envName: string;
  label: string;
  type: 'text' | 'password';
  required: boolean;
  help?: string;
}

export interface MakeConnection {
  /** Connection id used to reference from actions, e.g. 'eadFactoryApi'. */
  name: string;
  label: string;
  fields: MakeConnectionField[];
}

export interface MakeRomArtifact {
  /** Stable schema version for the make-rom.json shape itself. */
  artifactSchemaVersion: 1;
  /** Module metadata — what Make calls a "module". */
  module: {
    /** kebab-case id (matches the MCP id). */
    name: string;
    label: string;
    description: string;
    /** npm name of the SOURCE MCP — surfaced so reviewers can locate the implementation. */
    sourceMcpPackageName: string;
    /** Version aligned with the source MCP (FR32-style alignment). */
    version: string;
    sourceRepoUrl: string;
  };
  connection: MakeConnection;
  actions: MakeAction[];
  /**
   * Notes the pipeline surfaced while building the artifact — usually
   * about JSON-schema features it lowered (nested objects → json) or
   * placeholders the human reviewer must complete (HTTP gateway URL).
   */
  notes: string[];
}
