#!/usr/bin/env node

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalDigest,
  expectedSummary,
  frozenLedgerSections,
  sha256File,
  validateCapabilityEvidenceLedger,
  verifyAllExternalFiles,
  verifyEvidencePrivacyContent,
  verifyExternalFileRecord,
  verifyLocalGitBaselines,
} from './lib/capability-evidence-ledger-core.mjs';
import {
  parseJsonBytesRejectDuplicateKeys,
  parseJsonRejectDuplicateKeys,
} from './lib/strict-json.mjs';
import {
  validateApprovedRelease,
  validateReleaseProvenance,
} from './lib/release-provenance-core.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ledgerPath = join(root, 'release/capability-evidence-ledger-0.10.66.json');
const schemaPath = join(root, 'release/capability-evidence-ledger.v1.schema.json');
const EXPECTED_SECTION_DIGESTS = Object.freeze({
  identity: '4c85fe01c5565e7dc22e706cc67457cac35a6019fb67f7e30bd63a064a316432',
  baselines: 'c0aaa3a9b5631872eae3b5cf791da917ff6e8f94d9ba871de407eeb501e340ca',
  candidate: '4999164262bea90e11bfd46e8a260eb8aca985ae009e02f7a145c96ab1beb1d1',
  claims: '39359e7203a95ccd158b7d7828ffe46f3acff642ad4fb4e6f0bf87751042b2d4',
  evidence: 'd98d069fa914c1766ee65a47827d700156dfad9df324679c35b5f031a2702172',
});

function loadLedgerText(source, label = 'capability evidence ledger') {
  return parseJsonRejectDuplicateKeys(source, label);
}

function loadLedger() {
  return parseJsonBytesRejectDuplicateKeys(readFileSync(ledgerPath), 'capability evidence ledger');
}

function sectionDigests(ledger) {
  return Object.fromEntries(Object.entries(frozenLedgerSections(ledger)).map(
    ([section, value]) => [section, canonicalDigest(value)],
  ));
}

function validate(ledger, expectedSectionDigests = EXPECTED_SECTION_DIGESTS) {
  return validateCapabilityEvidenceLedger(ledger, {
    schemaPath,
    rootDir: root,
    expectedSectionDigests,
  });
}

function clone(value) {
  return structuredClone(value);
}

function expectReject(name, mutate, expectedPattern) {
  const candidate = clone(loadLedger());
  mutate(candidate);
  let failure;
  try {
    validate(candidate, sectionDigests(candidate));
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error, `${name}: mutation unexpectedly passed`);
  assert.match(failure.message, expectedPattern, name);
}

function expectFrozenReject(name, mutate) {
  const candidate = clone(loadLedger());
  mutate(candidate);
  assert.throws(() => validate(candidate), /frozen digest mismatch/u, name);
}

const SEMANTIC_FAILURE_PATTERNS = Object.freeze({
  'root extra field': /not allowed|unknown|additional|schema/iu,
  'baseline extra field': /not allowed|unknown|additional|schema/iu,
  'candidate nested extra field': /not allowed|unknown|additional|schema/iu,
  'source custody nested extra field': /not allowed|unknown|additional|schema/iu,
  'release plan hash drift': /release plan SHA-256 mismatch/u,
  'provenance schema hash drift': /provenance schema SHA-256 mismatch/u,
  'evidence extra field': /not allowed|unknown|additional|schema/iu,
  'locator extra field': /not allowed|unknown|additional|schema|oneOf branch/iu,
  'claim extra field': /not allowed|unknown|additional|schema/iu,
  'summary nested extra field': /not allowed|unknown|additional|schema/iu,
  'schema hash drift': /schema SHA-256 mismatch/u,
  'source proof inflated to owner physical': /exceeds evidence ceiling/u,
  'automated proof inflated to owner physical': /exceeds evidence ceiling/u,
  'NOT_RUN cites evidence': /NOT_RUN cannot cite positive evidence/u,
  'NOT_RUN marked satisfied': /satisfaction is inflated or stale/u,
  'failure marked satisfied': /satisfaction is inflated or stale/u,
  'positive claim without evidence': /positive proof requires evidence/u,
  'missing evidence reference': /references missing evidence/u,
  'candidate mismatch': /evidence candidate mismatch/u,
  'platform mismatch': /evidence platform mismatch/u,
  'source component platform mismatch': /source component\/platform mismatch/u,
  'wrong proof domain': /wrong proof domain/u,
  'nondeterministic summary count': /summary is not deterministic/u,
  'inflated release readiness': /summary is not deterministic/u,
  'blocking list drift': /summary is not deterministic/u,
  'unsorted evidence': /evidence must be unique and code-unit sorted/u,
  'duplicate claim': /claims must be unique and code-unit sorted/u,
  'multiple active Android candidates': /activeCandidateCount|schema/iu,
  'private local path': /private material|escapes the guarded evidence root|schema|oneOf branch/iu,
  'normalized traversal path': /already be normalized/u,
  'deep-link material': /private material|does not match/iu,
  'artifact source collapsed into current source': /must remain distinct from artifact source/u,
  'candidate artifact-source mismatch': /artifact-source binding mismatch/u,
  'candidate current-source mismatch': /current-source binding mismatch/u,
  'non-app artifact source invented': /artifact source must be null/u,
  'failure evidence misclassified': /failure ceiling mismatch/u,
  'candidate provenance hash detached': /candidate provenance is not bound to evidence/u,
  'invalid leap-day timestamp': /capturedAt day is invalid/u,
  'artifact binary falsely marked sanitized': /artifact privacy classification mismatch/u,
  'inspection falsely marked sanitized': /inspection privacy classification mismatch/u,
});

function runSelfTest() {
  const ledger = loadLedger();
  validate(ledger);
  const checks = [];
  const rejects = (name, mutate) => {
    const expectedPattern = SEMANTIC_FAILURE_PATTERNS[name];
    assert(expectedPattern, `${name}: expected semantic failure pattern is missing`);
    expectReject(name, mutate, expectedPattern);
    checks.push(name);
  };
  const rejectsFrozen = (name, mutate) => {
    expectFrozenReject(name, mutate);
    checks.push(name);
  };

  rejects('root extra field', (value) => { value.extra = true; });
  rejects('baseline extra field', (value) => { value.baselines[0].extra = true; });
  rejects('candidate nested extra field', (value) => { value.candidate.activeCandidateCount.extra = 1; });
  rejects('source custody nested extra field', (value) => { value.candidate.sourceCustody.android.extra = true; });
  rejects('release plan hash drift', (value) => { value.candidate.releasePlan.sha256 = '4'.repeat(64); });
  rejects('provenance schema hash drift', (value) => { value.candidate.provenanceSchema.sha256 = '5'.repeat(64); });
  rejects('evidence extra field', (value) => { value.evidence[0].extra = true; });
  rejects('locator extra field', (value) => { value.evidence[0].locator.extra = true; });
  rejects('claim extra field', (value) => { value.claims[0].extra = true; });
  rejects('summary nested extra field', (value) => { value.summary.classCounts.extra = 1; });
  rejects('schema hash drift', (value) => { value.schemaSha256 = '0'.repeat(64); });
  rejects('source proof inflated to owner physical', (value) => {
    const claim = value.claims.find((item) => item.id === 'source.android.model_pack.current');
    claim.observedClass = 'VERIFIED_OWNER_PHYSICAL';
    claim.requiredClass = 'VERIFIED_OWNER_PHYSICAL';
    claim.satisfiesRequirement = true;
    value.summary = expectedSummary(value);
  });
  rejects('automated proof inflated to owner physical', (value) => {
    const claim = value.claims.find((item) => item.id === 'automation.android.reliability.0.10.66');
    claim.observedClass = 'VERIFIED_OWNER_PHYSICAL';
    claim.requiredClass = 'VERIFIED_OWNER_PHYSICAL';
    claim.satisfiesRequirement = true;
    value.summary = expectedSummary(value);
  });
  rejects('NOT_RUN cites evidence', (value) => {
    const claim = value.claims.find((item) => item.id === 'test3.android.0.10.66');
    claim.evidenceIds = ['automation.android.0.10.66'];
  });
  rejects('NOT_RUN marked satisfied', (value) => {
    const claim = value.claims.find((item) => item.id === 'test3.android.0.10.66');
    claim.satisfiesRequirement = true;
    value.summary = expectedSummary(value);
  });
  rejects('failure marked satisfied', (value) => {
    const claim = value.claims.find((item) => item.id === 'test3.android.0.10.55');
    claim.satisfiesRequirement = true;
    value.summary = expectedSummary(value);
  });
  rejects('positive claim without evidence', (value) => {
    value.claims.find((item) => item.id === 'artifact.android.0.10.66').evidenceIds = [];
  });
  rejects('missing evidence reference', (value) => {
    value.claims.find((item) => item.id === 'artifact.android.0.10.66').evidenceIds = ['missing'];
  });
  rejects('candidate mismatch', (value) => {
    value.claims.find((item) => item.id === 'automation.android.reliability.0.10.66').candidate = '0.10.65';
  });
  rejects('platform mismatch', (value) => {
    value.claims.find((item) => item.id === 'automation.android.reliability.0.10.66').platform = 'ios';
  });
  rejects('source component platform mismatch', (value) => {
    value.evidence.find((item) => item.id === 'source.apps_android.input_baseline').platform = 'ios';
  });
  rejects('wrong proof domain', (value) => {
    const evidence = value.evidence.find((item) => item.id === 'automation.android.0.10.66');
    evidence.kind = 'AUTOMATED_RESULT';
    evidence.maximumClass = 'VERIFIED_AUTOMATED_PHYSICAL';
    const claim = value.claims.find((item) => item.id === 'artifact.android.0.10.66');
    claim.evidenceIds = ['automation.android.0.10.66'];
  });
  rejects('nondeterministic summary count', (value) => { value.summary.classCounts.NOT_RUN += 1; });
  rejects('inflated release readiness', (value) => { value.summary.releaseReady = true; });
  rejects('blocking list drift', (value) => { value.summary.releaseBlockingClaimIds = []; });
  rejectsFrozen('claims digest blocks blocker removal', (value) => {
    value.claims.forEach((claim) => { claim.releaseBlocking = false; });
    value.summary = expectedSummary(value);
  });
  rejectsFrozen('claims digest blocks mandatory removal', (value) => {
    value.claims = [value.claims.find((claim) => claim.id === 'source.android.model_pack.current')];
    value.summary = expectedSummary(value);
  });
  rejects('unsorted evidence', (value) => { value.evidence.reverse(); });
  rejects('duplicate claim', (value) => { value.claims[1].id = value.claims[0].id; });
  rejects('multiple active Android candidates', (value) => { value.candidate.activeCandidateCount.android = 2; });
  rejects('private local path', (value) => {
    value.evidence.find((item) => item.locator.type === 'EXTERNAL_FILE').locator.path = '/Users/private/evidence.json';
  });
  rejects('normalized traversal path', (value) => {
    value.evidence.find((item) => item.locator.type === 'EXTERNAL_FILE').locator.path =
      '/Volumes/DivaySSD/MainaBuild/artifacts/apps/release/../private.json';
  });
  rejects('deep-link material', (value) => { value.ledgerId = 'maina:///meeting/private'; });
  rejects('artifact source collapsed into current source', (value) => {
    const baseline = value.baselines.find((item) => item.component === 'apps_android');
    baseline.artifactSourceRevision = baseline.inputRevision;
  });
  rejects('candidate artifact-source mismatch', (value) => {
    value.candidate.sourceCustody.android.artifactSourceCommit = '2'.repeat(40);
  });
  rejects('candidate current-source mismatch', (value) => {
    value.candidate.sourceCustody.ios.currentSourceBaseline = '3'.repeat(40);
  });
  rejects('non-app artifact source invented', (value) => {
    value.baselines.find((item) => item.component === 'backend').artifactSourceRevision = '1'.repeat(40);
  });
  rejects('failure evidence misclassified', (value) => {
    value.evidence.find((item) => item.id === 'failure.test3.0.10.55').maximumClass = 'VERIFIED_OWNER_PHYSICAL';
  });
  rejectsFrozen('evidence digest blocks automated relabel', (value) => {
    const evidence = value.evidence.find((item) => item.id === 'automation.android.0.10.66');
    evidence.kind = 'OWNER_PHYSICAL_RESULT';
    evidence.maximumClass = 'VERIFIED_OWNER_PHYSICAL';
    const claim = value.claims.find((item) => item.id === 'test3.android.0.10.66');
    claim.observedClass = 'VERIFIED_OWNER_PHYSICAL';
    claim.evidenceIds = [evidence.id];
    claim.satisfiesRequirement = true;
    value.summary = expectedSummary(value);
  });
  rejectsFrozen('evidence digest blocks privacy relabel', (value) => {
    value.evidence.find((item) => item.id === 'automation.ios.0.10.66').privacyClass = 'SANITIZED';
  });
  rejects('candidate provenance hash detached', (value) => {
    value.candidate.candidateProvenanceSha256 = '6'.repeat(64);
  });
  rejects('invalid leap-day timestamp', (value) => { value.capturedAt = '2026-02-29T00:00:00Z'; });
  rejects('artifact binary falsely marked sanitized', (value) => {
    value.evidence.find((item) => item.id === 'artifact.ios.app.0.10.66').privacyClass = 'SANITIZED';
  });
  rejects('inspection falsely marked sanitized', (value) => {
    value.evidence.find((item) => item.id === 'artifact.ios.inspection.0.10.66').privacyClass = 'SANITIZED';
  });
  rejectsFrozen('identity digest blocks ledger ID rewrite', (value) => {
    value.ledgerId = 'maina-0.10.66-capability-evidence-20991231';
  });
  rejectsFrozen('identity digest blocks capture-time rewrite', (value) => {
    value.capturedAt = '2099-12-31T23:59:59Z';
  });
  assert.throws(
    () => verifyEvidencePrivacyContent(
      { id: 'fixture.local', privacyClass: 'LOCAL_PATH_METADATA' },
      Buffer.from('signer@example.com\n'),
    ),
    /LOCAL_PATH_METADATA evidence contains private material/u,
  );
  checks.push('local-path metadata cannot conceal signing identity');
  verifyEvidencePrivacyContent(
    { id: 'fixture.local', privacyClass: 'LOCAL_PATH_METADATA' },
    Buffer.from('/Users/example/build/output\n'),
  );
  checks.push('local-path metadata permits its declared path class');
  assert.throws(
    () => verifyEvidencePrivacyContent(
      { id: 'fixture.sanitized', privacyClass: 'SANITIZED' },
      Buffer.from('/Users/example/private\n'),
    ),
    /SANITIZED evidence contains private material/u,
  );
  checks.push('sanitized evidence rejects local private paths');
  verifyEvidencePrivacyContent(
    { id: 'fixture.private', privacyClass: 'PRIVATE_BUILD_METADATA' },
    Buffer.from('signer@example.com\n'),
  );
  checks.push('private build metadata is explicitly classified');

  const rawLedger = readFileSync(ledgerPath, 'utf8');
  assert.throws(
    () => loadLedgerText(rawLedger.replace(
      '  "ledgerId":',
      '  "ledgerId": "private-shadow",\n  "ledgerId":',
    )),
    /duplicate object key "ledgerId"/u,
  );
  checks.push('duplicate root JSON key rejected');
  assert.throws(
    () => loadLedgerText(rawLedger.replace(
      '    "name": "maina-capability-evidence-harness",',
      '    "name": "shadow",\n    "name": "maina-capability-evidence-harness",',
    )),
    /duplicate object key "name"/u,
  );
  checks.push('duplicate nested JSON key rejected');
  assert.throws(
    () => loadLedgerText(rawLedger.replace(
      '  "ledgerId":',
      '  "\\u006cedgerId": "escape-shadow",\n  "ledgerId":',
    )),
    /duplicate object key "ledgerId"/u,
  );
  checks.push('escape-equivalent duplicate JSON key rejected');
  assert.throws(
    () => parseJsonBytesRejectDuplicateKeys(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])),
    /invalid UTF-8/u,
  );
  checks.push('invalid UTF-8 JSON rejected');

  const temporary = mkdtempSync(join(tmpdir(), 'maina-ledger-test-'));
  try {
    const file = join(temporary, 'evidence.json');
    writeFileSync(file, '{}\n', { mode: 0o600 });
    const valid = {
      type: 'EXTERNAL_FILE', path: file, bytes: 3, mode: '0600', sha256: sha256File(file),
    };
    const stableSnapshot = verifyExternalFileRecord(valid, { allowedRoot: temporary });
    checks.push('external regular-file identity');
    assert.throws(() => verifyExternalFileRecord({ ...valid, bytes: 4 }, { allowedRoot: temporary }));
    checks.push('external byte drift rejected');
    assert.throws(() => verifyExternalFileRecord({ ...valid, mode: '0644' }, { allowedRoot: temporary }));
    checks.push('external mode drift rejected');
    assert.throws(() => verifyExternalFileRecord({ ...valid, sha256: '0'.repeat(64) }, { allowedRoot: temporary }));
    checks.push('external SHA drift rejected');
    const link = join(temporary, 'link.json');
    symlinkSync(file, link);
    assert.throws(() => verifyExternalFileRecord({ ...valid, path: link }, { allowedRoot: temporary }));
    checks.push('external symlink rejected');
    const guarded = join(temporary, 'guarded');
    const escaped = join(temporary, 'escaped');
    mkdirSync(guarded);
    mkdirSync(escaped);
    const escapedFile = join(escaped, 'evidence.json');
    writeFileSync(escapedFile, '{}\n', { mode: 0o600 });
    symlinkSync(escaped, join(guarded, 'linked-parent'));
    assert.throws(() => verifyExternalFileRecord({
      ...valid,
      path: join(guarded, 'linked-parent/evidence.json'),
      sha256: sha256File(escapedFile),
    }, { allowedRoot: guarded }));
    checks.push('external parent symlink escape rejected');
    writeFileSync(file, '[]\n', { mode: 0o600 });
    assert.equal(stableSnapshot.content.toString('utf8'), '{}\n');
    checks.push('external semantics retain verified descriptor bytes after path replacement');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  console.log(`Capability evidence ledger adversarial self-test PASS (${checks.length}/${checks.length}).`);
}

function verifyBoundEvidenceContents(ledger, snapshots) {
  const byId = new Map(ledger.evidence.map((item) => [item.id, item]));
  const readEvidenceBytes = (id) => {
    const record = byId.get(id);
    assert(record, `${id}: evidence record is absent`);
    const verified = snapshots.get(record.locator.path);
    assert(verified, `${id}: verified descriptor snapshot is absent`);
    return verified.content;
  };
  const readJsonEvidence = (id) => parseJsonBytesRejectDuplicateKeys(readEvidenceBytes(id), id);
  const planBytes = readFileSync(join(root, ledger.candidate.releasePlan.path));
  const plan = parseJsonBytesRejectDuplicateKeys(planBytes, 'release plan');
  const planSha256 = ledger.candidate.releasePlan.sha256;
  const candidate = readJsonEvidence('provenance.candidate.0.10.66');
  const approved = readJsonEvidence('provenance.approved.0.10.66');
  validateReleaseProvenance(candidate, plan, { requireBoth: true, planSha256 });
  validateApprovedRelease(approved, plan, { planSha256, fileSnapshots: snapshots });

  const assertProvenanceBindings = (provenance) => {
    for (const platform of ['android', 'ios']) {
      assert.equal(
        provenance.sources[platform].finalCommit,
        ledger.candidate.sourceCustody[platform].artifactSourceCommit,
        `${platform} provenance source must equal ledger artifact source`,
      );
      assert.equal(
        provenance.sources[platform].upstreamCommit,
        ledger.candidate.sourceCustody[platform].artifactSourceCommit,
        `${platform} provenance upstream must equal ledger artifact source`,
      );
      const artifactRecord = byId.get(`artifact.${platform}.${platform === 'android' ? 'apk' : 'app'}.0.10.66`);
      const buildLogRecord = byId.get(`artifact.${platform}.build_log.0.10.66`);
      const inspectionRecord = byId.get(`artifact.${platform}.inspection.0.10.66`);
      assert.equal(provenance.artifacts[platform].path, artifactRecord.locator.path);
      assert.equal(provenance.artifacts[platform].bytes, artifactRecord.locator.bytes);
      assert.equal(provenance.artifacts[platform].sha256, artifactRecord.locator.sha256);
      assert.equal(provenance.artifacts[platform].buildLog.path, buildLogRecord.locator.path);
      assert.equal(provenance.artifacts[platform].buildLog.bytes, buildLogRecord.locator.bytes);
      assert.equal(provenance.artifacts[platform].buildLog.sha256, buildLogRecord.locator.sha256);
      assert.equal(provenance.artifacts[platform].inspection.path, inspectionRecord.locator.path);
      assert.equal(provenance.artifacts[platform].inspection.bytes, inspectionRecord.locator.bytes);
      assert.equal(provenance.artifacts[platform].inspection.sha256, inspectionRecord.locator.sha256);
    }
    const symbolsRecord = byId.get('artifact.ios.dsym.0.10.66');
    assert.equal(provenance.artifacts.ios.debugSymbols.path, symbolsRecord.locator.path);
    assert.equal(provenance.artifacts.ios.debugSymbols.bytes, symbolsRecord.locator.bytes);
    assert.equal(provenance.artifacts.ios.debugSymbols.sha256, symbolsRecord.locator.sha256);
  };
  assertProvenanceBindings(candidate);
  assertProvenanceBindings(approved);
  assert.equal(candidate.approval.status, 'candidate');
  assert.equal(candidate.approval.approvedBy, null);
  assert.equal(candidate.approval.approvedAt, null);
  assert.equal(approved.approval.status, 'admin-approved');
  const ownerAuthorizationRecord = byId.get('authorization.owner.0.10.66');
  assert.equal(approved.approval.authorization.path, ownerAuthorizationRecord.locator.path);
  assert.equal(approved.approval.authorization.bytes, ownerAuthorizationRecord.locator.bytes);
  assert.equal(approved.approval.authorization.sha256, ownerAuthorizationRecord.locator.sha256);
  assert.equal(approved.approval.authorization.candidateProvenanceSha256, ledger.candidate.candidateProvenanceSha256);
  assert.equal(approved.approval.authorization.planSha256, planSha256);
  assert.equal(approved.artifacts.android.sha256, byId.get('artifact.android.apk.0.10.66').locator.sha256);
  assert.equal(approved.artifacts.ios.sha256, byId.get('artifact.ios.app.0.10.66').locator.sha256);
  assert.equal(approved.artifacts.ios.debugSymbols.sha256, byId.get('artifact.ios.dsym.0.10.66').locator.sha256);

  const verification = readJsonEvidence('provenance.verification.0.10.66');
  assert.equal(verification.schemaVersion, 'maina.dual-provenance-verification.v2');
  assert.equal(verification.releaseId, ledger.candidate.releaseId);
  assert.equal(verification.status, 'verified_owner_authorized');
  assert.equal(verification.inputs.planSha256, planSha256);
  assert.equal(verification.inputs.candidateProvenanceSha256, ledger.candidate.candidateProvenanceSha256);
  assert.equal(verification.inputs.androidArtifactSha256, byId.get('artifact.android.apk.0.10.66').locator.sha256);
  assert.equal(verification.inputs.iosArtifactSha256, byId.get('artifact.ios.app.0.10.66').locator.sha256);
  assert.equal(verification.output.sha256, ledger.candidate.approvedProvenanceSha256);
  assert.equal(verification.checks.deviceActionsPerformed, false);

  const android = readJsonEvidence('automation.android.0.10.66');
  assert.equal(android.schemaVersion, 'maina.android-automated-qualification.v1');
  assert.equal(android.release, '0.10.66(92)');
  assert.equal(android.status, 'passed');
  assert.equal(android.physicalIncomingCallTestPerformed, false);
  assert.deepEqual(android.installedIdentity, { version: '0.10.66', build: 92 });
  assert.equal(android.tests.length, 11);
  assert(android.tests.every((test) => test.status === 'PASS'));
  assert.equal(new Set(android.tests.map((test) => test.name)).size, 11);
  assert.equal(android.rawHierarchyPersisted, false);
  assert.equal(android.rawDeviceLogsPersisted, false);
  const androidClaim = ledger.claims.find((claim) => claim.id === 'automation.android.reliability.0.10.66');
  assert.equal(androidClaim.observedClass, 'HARNESS_BLOCKED');
  assert.equal(androidClaim.reasonCode, 'RESULT_LACKS_EXACT_INSTALLED_ARTIFACT_BINDING');

  const ios = readJsonEvidence('automation.ios.0.10.66');
  assert.equal(ios.title, 'Test - MainaUITests');
  assert.equal(ios.result, 'Passed');
  assert.equal(ios.totalTestCount, 8);
  assert.equal(ios.passedTests, 8);
  assert.equal(ios.failedTests, 0);
  assert.equal(ios.skippedTests, 0);
  assert.equal(ios.devicesAndConfigurations.length, 1);
  assert.equal(ios.devicesAndConfigurations[0].passedTests, 8);
  assert.equal(ios.devicesAndConfigurations[0].failedTests, 0);
  const iosClaim = ledger.claims.find((claim) => claim.id === 'automation.ios.ui.0.10.66');
  assert.equal(iosClaim.observedClass, 'HARNESS_BLOCKED');
  assert.equal(iosClaim.reasonCode, 'RESULT_LACKS_INSTALLED_CANDIDATE_BINDING');

  const failure = readEvidenceBytes('failure.test3.0.10.55').toString('utf8');
  assert.match(failure, /The 0\.10\.55 failures are two different lifecycle bugs/u);
  assert.match(failure, /Maina stayed paused for more than 90 seconds/u);
  assert.match(failure, /no unattended resume for more than 60 seconds/u);
}

const args = new Set(process.argv.slice(2));
if (args.has('--self-test')) runSelfTest();
const ledger = loadLedger();
validate(ledger);
if (args.has('--verify-external')) {
  const snapshots = verifyAllExternalFiles(ledger);
  verifyBoundEvidenceContents(ledger, snapshots);
}
if (args.has('--verify-local-git')) {
  verifyLocalGitBaselines(ledger, {
    apps_android: '/Users/divay/Developer/MainaV2',
    apps_ios: '/Users/divay/Developer/.worktrees/maina-ios-feasibility',
    backend: '/Users/divay/Developer/.worktrees/mkc-retrieval-vnext',
    web: '/Users/divay/Developer/.worktrees/mkc-web-retrieval-vnext',
    coordination: '/Users/divay/Developer/maina-coordination',
  });
}
console.log(
  `Capability evidence ledger PASS (${ledger.claims.length} claims; releaseReady=${ledger.summary.releaseReady}; `
  + `externalEvidenceVerified=${args.has('--verify-external')}; localGitVerified=${args.has('--verify-local-git')}; `
  + 'deviceCommandsExecuted=0).',
);
