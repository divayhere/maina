#!/usr/bin/env ruby
# frozen_string_literal: true

require "cocoapods"
require "pathname"
require "xcodeproj"

REASON = "IOS_POD_SOURCE_MEMBERSHIP_STALE"
CANONICAL_ROOT = "/Users/divay/Developer/.worktrees/maina-ios-feasibility"

class MembershipError < StandardError; end

def validate_membership(expected, actual, target_count:, allowed_generated:)
  raise MembershipError, "target_count" unless target_count == 1
  raise MembershipError, "expected_empty" if expected.empty?
  raise MembershipError, "expected_duplicate" unless expected.uniq.length == expected.length
  raise MembershipError, "actual_duplicate" unless actual.uniq.length == actual.length

  required = (expected + allowed_generated).sort
  raise MembershipError, "source_set" unless actual.sort == required

  true
end

def expect_reject(label)
  yield
  raise "self-test failed: #{label} was accepted"
rescue MembershipError
  true
end

if ARGV == ["--self-test"]
  expected = ["/module/A.swift", "/module/B.swift"]
  dummy = ["/pods/MainaRecorder-dummy.m"]
  actual = expected + dummy
  checks = 0
  checks += 1 if validate_membership(expected, actual, target_count: 1, allowed_generated: dummy)
  checks += 1 if expect_reject("missing source") do
    validate_membership(expected, [expected.first, *dummy], target_count: 1, allowed_generated: dummy)
  end
  checks += 1 if expect_reject("extra source") do
    validate_membership(expected, [*actual, "/module/Unexpected.swift"], target_count: 1, allowed_generated: dummy)
  end
  checks += 1 if expect_reject("duplicate source") do
    validate_membership(expected, [*actual, expected.first], target_count: 1, allowed_generated: dummy)
  end
  checks += 1 if expect_reject("duplicate target") do
    validate_membership(expected, actual, target_count: 2, allowed_generated: dummy)
  end
  checks += 1 if expect_reject("wrong generated source") do
    validate_membership(expected, expected + ["/tmp/MainaRecorder-dummy.m"], target_count: 1, allowed_generated: dummy)
  end
  abort "self-test count mismatch" unless checks == 6

  puts "iOS pod source membership self-test PASS (6/6)."
  exit 0
end

begin
  project_root = File.realpath(File.expand_path("..", __dir__))
  raise MembershipError, "project_root" unless project_root == CANONICAL_ROOT

  module_root = Pathname.new(File.join(project_root, "modules/maina-recorder/ios")).realpath
  podspec_path = module_root.join("MainaRecorder.podspec")
  podspec_stat = File.lstat(podspec_path)
  raise MembershipError, "podspec_identity" unless podspec_stat.file? && !podspec_stat.symlink?

  spec = Pod::Specification.from_file(podspec_path)
  consumer = spec.consumer(Pod::Platform.new(:ios, "16.4"))
  accessor = Pod::Sandbox::FileAccessor.new(module_root, consumer)
  expected = accessor.source_files.map do |source|
    stat = File.lstat(source)
    raise MembershipError, "source_identity" unless stat.file? && !stat.symlink?
    canonical = source.realpath.to_s
    raise MembershipError, "source_root" unless canonical.start_with?("#{module_root}/")
    canonical
  end.sort

  pods_project_path = File.join(project_root, "ios/Pods/Pods.xcodeproj")
  project = Xcodeproj::Project.open(pods_project_path)
  targets = project.targets.select { |target| target.name == "MainaRecorder" }
  actual = targets.flat_map do |target|
    target.source_build_phase.files_references.map do |reference|
      canonical = reference.real_path.realpath.to_s
      stat = File.lstat(canonical)
      raise MembershipError, "generated_source_identity" unless stat.file? && !stat.symlink?
      canonical
    end
  end

  dummy = Pathname.new(
    File.join(project_root, "ios/Pods/Target Support Files/MainaRecorder/MainaRecorder-dummy.m"),
  ).realpath.to_s
  validate_membership(expected, actual, target_count: targets.length, allowed_generated: [dummy])
  puts "iOS MainaRecorder pod source membership PASS (#{expected.length} podspec sources)."
rescue MembershipError, Errno::ENOENT, Pod::Informative, Xcodeproj::PlainInformative => error
  warn "#{REASON}: #{error.message}"
  exit 78
end
