const windowsDeviceNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** Validates one cross-platform managed-storage segment, including Windows device-name rules. */
export function isSafeManagedPathSegment(value: string, maximumLength: number): boolean {
  return (
    value.length <= maximumLength &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value) &&
    !value.endsWith('.') &&
    !windowsDeviceNamePattern.test(value)
  );
}
