// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ManagedAgentError } from "../agents/interface.ts";

export const commandSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(256),
    description: z.string().max(4000),
    argumentHint: z.string().max(512).optional(),
    kind: z.enum(["skill", "command"]),
    source: z.string().max(1024).optional(),
  })
  .strict();
export type AgentCommand = z.infer<typeof commandSchema>;
export const referencesSchema = z
  .array(
    z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        text: z.string().min(1).max(4096),
        kind: z.enum(["file", "command"]),
        id: z.string().min(1).max(4096),
      })
      .strict(),
  )
  .max(100);
export type ComposerReference = z.infer<typeof referencesSchema>[number];
export function validateReferences(text: string, references: ComposerReference[]): void {
  let end = 0,
    command = false;
  for (const ref of [...references].sort((a, b) => a.start - b.start)) {
    const splitsSurrogate = (index: number) =>
      index > 0 && /[\uD800-\uDBFF]/u.test(text[index - 1]!) && /[\uDC00-\uDFFF]/u.test(text[index] ?? "");
    if (
      ref.start < end ||
      ref.end <= ref.start ||
      text.slice(ref.start, ref.end) !== ref.text ||
      splitsSurrogate(ref.start) ||
      splitsSurrogate(ref.end)
    )
      throw new ManagedAgentError("invalid-reference", "A selected reference changed. Select it again.", 422);
    if (ref.kind === "command") {
      if (command || text.slice(0, ref.start).trim() || !ref.text.startsWith("/"))
        throw new ManagedAgentError("invalid-reference", "A command must be the first word in the message.", 422);
      command = true;
    } else if (ref.text !== `@${/^[\p{L}\p{N}_./-]+$/u.test(ref.id) ? ref.id : JSON.stringify(ref.id)}`)
      throw new ManagedAgentError("invalid-reference", "Select the file again.", 422);
    end = ref.end;
  }
}
