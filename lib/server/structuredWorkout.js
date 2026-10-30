/*
 * Server entry for the structured-workout core. The logic lives in ONE file,
 * js/structuredWorkout.js, which the browser loads as a classic script; it is
 * imported here for its side effect so server and client can never drift.
 */
import "../../js/structuredWorkout.js";

export const SW = globalThis.AthlevoStructuredWorkout;
