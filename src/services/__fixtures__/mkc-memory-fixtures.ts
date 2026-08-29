export const verifiedMemoryFixture = {
  ownerUserId: 'owner-a',
  checksums: [
    { field: 'result_checksum', expected: 'sha256:result-a', received: 'sha256:result-a' },
    { field: 'bundle_checksum', expected: 'sha256:bundle-a', received: 'sha256:bundle-a' },
  ],
  payload: { deliberatelyOpaqueUntilGeneratedSchemasArrive: true },
} as const;
