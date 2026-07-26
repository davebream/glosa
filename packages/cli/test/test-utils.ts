// SPDX-License-Identifier: Apache-2.0
// Shared test-only helpers for the P5.1 command surface's test files.
export function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // biome-ignore lint: test-only stdout capture
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

export function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  // biome-ignore lint: test-only stderr capture
  (process.stderr.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

export async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // biome-ignore lint: test-only stdout capture
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}
