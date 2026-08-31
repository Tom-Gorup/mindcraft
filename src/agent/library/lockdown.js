import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

let lockeddown = false;
let lockdown_failed = false;

// True only if SES hardening actually succeeded. Generated code must not run
// otherwise: with untamed intrinsics, any endowed host function reaches the
// primal realm via `fn.constructor('return globalThis')()`.
export function isLockedDown() {
  return lockeddown && !lockdown_failed;
}

export function lockdown() {
  if (lockeddown) return;
  lockeddown = true;
  // NOTE: must call the SES global explicitly — a bare `lockdown(...)` here
  // resolves to this wrapper function and silently recurses into the guard,
  // meaning SES hardening never actually ran. (Fixed 2026-08-30.)
  try {
    globalThis.lockdown({
    // basic devex and quality of life improvements
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose',
    // allow eval outside of created compartments
    // (mineflayer dep "protodef" uses eval)
    evalTaming: 'unsafeEval',
    // libraries loaded before lockdown may hold mutated intrinsics
    overrideTaming: 'severe',
    });
  } catch (err) {
    lockdown_failed = true;
    console.error('SES lockdown FAILED — code generation will be refused:', err.message || err);
  }
}

export const makeCompartment = (endowments = {}) => {
  return new Compartment({
    // provide untamed Math, Date, etc
    Math,
    Date,
    // standard endowments
    ...endowments
  });
}