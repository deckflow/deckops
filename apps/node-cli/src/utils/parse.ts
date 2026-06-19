export function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(`Invalid ${label}: ${value}\nExpected: a positive integer`);
  }

  return Number.parseInt(value, 10);
}

export function parseNonNegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value.trim())) {
    throw new Error(`Invalid ${label}: ${value}\nExpected: a non-negative integer`);
  }

  return Number.parseInt(value, 10);
}
