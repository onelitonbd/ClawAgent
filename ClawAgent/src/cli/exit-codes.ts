// Process exit codes.
//
// Their own module because `main.ts` dispatches to command modules, and a command
// module that imported `main.ts` for its exit codes would create a cycle. Every
// code a ClawAgent process can return is listed here, so a shell script can match
// on them without reading the CLI source.

/** Success. */
export const EXIT_OK = 0;
/** The device cannot run ClawAgent, or a check failed (`doctor`). */
export const EXIT_UNHEALTHY = 1;
/** Bad flags, unknown command, or a usage mistake. */
export const EXIT_USAGE = 2;
/** The command cannot start because config or credentials are unusable. */
export const EXIT_CONFIG = 3;
/** A model turn failed after startup: network, auth, or provider error. */
export const EXIT_PROVIDER = 4;
