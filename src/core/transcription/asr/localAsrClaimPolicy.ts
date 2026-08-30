export type LocalAsrClaimIdentity = {
  generation: number;
  token: string;
};

export function canCommitLocalAsrWindow(input: {
  expected: LocalAsrClaimIdentity;
  run: (LocalAsrClaimIdentity & { state: string }) | null;
  window: (LocalAsrClaimIdentity & { state: string }) | null;
}): boolean {
  return input.run?.state === 'claimed'
    && input.window?.state === 'claimed'
    && input.run.generation === input.expected.generation
    && input.window.generation === input.expected.generation
    && input.run.token === input.expected.token
    && input.window.token === input.expected.token;
}
