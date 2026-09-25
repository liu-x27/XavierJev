/**
 * Checks on the numbers a decision is configured with, made once, when it is
 * built.
 *
 * A threshold outside (0, 1) does not fail: it quietly turns a decision into
 * "always" or "never" — a gate at 1.5 clears everything, a stop judge at 0
 * stops every run. A timeout of NaN never fires. None of these would show up
 * as an error anywhere, so they are refused at construction instead.
 */

/** A threshold on a probability: strictly between 0 and 1. */
export function probabilityOption(name: string, value: number): number {
  if (!(value > 0 && value < 1)) throw new RangeError(`${name} must be strictly between 0 and 1, got ${value}`);
  return value;
}

/** A count or a duration: a finite number above zero, and a whole one if `integer`. */
export function positiveOption(name: string, value: number, integer = false): number {
  if (!(Number.isFinite(value) && value > 0) || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be a positive ${integer ? "whole number" : "number"}, got ${value}`);
  }
  return value;
}
