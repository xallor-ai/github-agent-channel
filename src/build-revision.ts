/** Operator-supplied deployment revision, never inferred from the task workspace. */
export function buildRevision(): string | null {
  const value = process.env.CHANNEL_BUILD_SHA;
  return value?.length === 40 && /^[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
}
