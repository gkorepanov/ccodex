import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeQueryInput {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

export const createClaudeQuery: ClaudeQueryFactory = (input) => query(input);
